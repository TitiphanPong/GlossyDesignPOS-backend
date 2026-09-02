import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, Types, createConnection } from 'mongoose';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  Counter,
  CounterDocument,
  CounterSchema,
  COUNTER_TYPE_QUOTATION,
} from '../counters/counters.schema';
import { RunningNumberService } from '../counters/running-number.service';
import type { CustomerDocument } from '../customers/schemas/customer.schema';
import type { OrderPricingService } from '../orders/order-pricing.service';
import { Order, OrderDocument, OrderSchema } from '../orders/orders.schema';
import {
  QuotationRevisionRecord,
  QuotationRevisionRecordDocument,
  QuotationRevisionRecordSchema,
} from './quotation-revision.schema';
import {
  Quotation,
  QuotationDocument,
  QuotationSchema,
} from './quotation.schema';
import { QuotationsService } from './quotations.service';

jest.setTimeout(120_000);

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === '1' ? describe : describe.skip;

const actor: AuthenticatedUser = {
  id: '64b000000000000000000001',
  username: 'manager',
  role: 'manager',
};

describeMongo('QuotationsService Mongo transaction integration', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let quotationModel: Model<QuotationDocument>;
  let quotationRevisionModel: Model<QuotationRevisionRecordDocument>;
  let orderModel: Model<OrderDocument>;
  let counterModel: Model<CounterDocument>;
  const ordersSse = { emitOrder: jest.fn() };
  const notificationsService = {
    handleOrderPaymentState: jest.fn(() => Promise.resolve()),
  };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    connection = createConnection(replSet.getUri(), {
      dbName: 'glossy-quotation-integrity',
    });
    await connection.asPromise();
    quotationModel = connection.model(
      Quotation.name,
      QuotationSchema,
    ) as unknown as Model<QuotationDocument>;
    quotationRevisionModel = connection.model(
      QuotationRevisionRecord.name,
      QuotationRevisionRecordSchema,
    ) as unknown as Model<QuotationRevisionRecordDocument>;
    orderModel = connection.model(
      Order.name,
      OrderSchema,
    ) as unknown as Model<OrderDocument>;
    counterModel = connection.model(
      Counter.name,
      CounterSchema,
    ) as unknown as Model<CounterDocument>;
    await Promise.all([
      quotationModel.syncIndexes(),
      quotationRevisionModel.syncIndexes(),
      orderModel.syncIndexes(),
      counterModel.syncIndexes(),
    ]);
  });

  afterAll(async () => {
    await connection?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    ordersSse.emitOrder.mockClear();
    notificationsService.handleOrderPaymentState.mockClear();
    await Promise.all([
      quotationModel.deleteMany({}),
      quotationRevisionModel.deleteMany({}),
      orderModel.deleteMany({}),
      counterModel.deleteMany({}),
    ]);
  });

  function service(runningNumber = new RunningNumberService(counterModel)) {
    return new QuotationsService(
      quotationModel,
      quotationRevisionModel,
      orderModel,
      {} as Model<CustomerDocument>,
      {} as OrderPricingService,
      runningNumber,
      ordersSse as never,
      notificationsService as never,
      connection,
    );
  }

  async function createApprovedQuotation() {
    return quotationModel.create({
      quotationNumber: 'QT-202609-0001',
      revision: 1,
      status: 'APPROVED',
      createdBy: actor.id,
      updatedBy: actor.id,
      customerSnapshot: {
        customerName: 'Concurrent Customer',
        phoneNumber: '0812345678',
      },
      items: [
        {
          name: 'Custom premium print',
          quantity: 2,
          unit: 'งาน',
          authoritativeUnitPrice: 107.25,
          lineTotal: 214.5,
          priceOverride: {
            unitPrice: 107.25,
            reason: 'Manager-approved quotation price',
            approvedBy: actor.id,
            approvedAt: new Date('2026-09-01T02:00:00.000Z'),
          },
        },
      ],
      subtotal: 214.5,
      discount: 0,
      taxableAmount: 214.5,
      vatRate: 7,
      vatAmount: 15.02,
      grandTotal: 229.52,
      taxInvoiceRequested: true,
      currency: 'THB',
      statusHistory: [
        {
          status: 'APPROVED',
          action: 'APPROVE',
          actor: actor.id,
          timestamp: new Date('2026-09-01T03:00:00.000Z'),
        },
      ],
      revisionHistory: [],
    });
  }

  it('allocates unique quotation numbers concurrently within the same Bangkok month', async () => {
    const runningNumber = new RunningNumberService(counterModel);
    const issuedAt = new Date('2026-09-15T03:00:00.000Z');
    const allocated = await Promise.all(
      Array.from({ length: 20 }, () =>
        runningNumber.generateQuotationNumber(issuedAt),
      ),
    );

    expect(new Set(allocated.map((row) => row.quotationNumber)).size).toBe(20);
    expect(allocated.map((row) => row.quotationSequence).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) =>
        String(index + 1).padStart(4, '0'),
      ),
    );
    expect(
      await counterModel.countDocuments({ type: COUNTER_TYPE_QUOTATION }),
    ).toBe(1);
  });

  it('stores real item fields in an immutable revision snapshot from Mongoose subdocuments', async () => {
    const quotation = await createApprovedQuotation();
    const revised = await service().revise(
      quotation._id.toString(),
      { version: quotation.__v, reason: 'ลูกค้าขอแก้สเปกหลังอนุมัติ' },
      actor,
    );

    expect(revised.status).toBe('DRAFT');
    expect(revised.revision).toBe(2);
    expect(revised.revisionHistory).toHaveLength(1);
    expect(revised.revisionHistory[0].items[0]).toMatchObject({
      name: 'Custom premium print',
      quantity: 2,
      unit: 'งาน',
      authoritativeUnitPrice: 107.25,
      lineTotal: 214.5,
    });
    expect(revised.revisionHistory[0].items[0].priceOverride).toMatchObject({
      unitPrice: 107.25,
      reason: 'Manager-approved quotation price',
      approvedBy: actor.id,
    });

    const storedParent = await quotationModel.findById(quotation._id).lean();
    expect(storedParent?.revisionHistory).toEqual([]);
    expect(
      await quotationRevisionModel.countDocuments({
        quotationId: quotation._id,
      }),
    ).toBe(1);
  });

  it('merges legacy embedded and external revision history in deterministic order', async () => {
    const quotation = await createApprovedQuotation();
    await quotationModel.updateOne(
      { _id: quotation._id },
      {
        $set: {
          revision: 2,
          revisionHistory: [
            {
              revision: 0,
              status: 'SENT',
              quotationNumber: 'QT-202609-0001',
              customerSnapshot: { customerName: 'Legacy Customer' },
              items: [],
              subtotal: 10,
              discount: 0,
              taxableAmount: 10,
              vatRate: 7,
              vatAmount: 0,
              grandTotal: 10,
              taxInvoiceRequested: false,
              currency: 'THB',
              snapshotBy: actor.id,
              snapshotAt: new Date('2026-09-01T01:00:00.000Z'),
            },
          ],
        },
      },
    );
    await quotationRevisionModel.create({
      quotationId: quotation._id,
      revision: 1,
      snapshot: {
        revision: 1,
        status: 'APPROVED',
        quotationNumber: 'QT-202609-0001',
        customerSnapshot: { customerName: 'External Customer' },
        items: [],
        subtotal: 20,
        discount: 0,
        taxableAmount: 20,
        vatRate: 7,
        vatAmount: 0,
        grandTotal: 20,
        taxInvoiceRequested: false,
        currency: 'THB',
        snapshotBy: actor.id,
        snapshotAt: new Date('2026-09-01T02:00:00.000Z'),
      },
    });

    const found = await service().findById(quotation._id.toString());

    expect(found.revisionHistory.map((snapshot) => snapshot.revision)).toEqual([
      0, 1,
    ]);
    expect(found.revisionHistory[0].customerSnapshot.customerName).toBe(
      'Legacy Customer',
    );
    expect(found.revisionHistory[1].customerSnapshot.customerName).toBe(
      'External Customer',
    );
  });

  it('deduplicates concurrent conversion and returns the same Order on retry', async () => {
    const quotation = await createApprovedQuotation();
    const quotations = service();

    const [left, right] = await Promise.all([
      quotations.convertToOrder(
        quotation._id.toString(),
        { version: 0 },
        actor,
        'quotation-convert-concurrent',
      ),
      quotations.convertToOrder(
        quotation._id.toString(),
        { version: 0 },
        actor,
        'quotation-convert-concurrent',
      ),
    ]);

    expect(left.order._id).toBe(right.order._id);
    expect(await orderModel.countDocuments()).toBe(1);

    const storedQuotation = await quotationModel.findById(quotation._id).lean();
    const storedOrder = await orderModel.findOne().lean();
    expect(storedQuotation).toMatchObject({
      status: 'CONVERTED',
      quotationNumber: 'QT-202609-0001',
      revision: 1,
    });
    expect(storedQuotation?.convertedOrderId?.toString()).toBe(
      storedOrder?._id.toString(),
    );
    expect(storedOrder).toMatchObject({
      quotationNumber: 'QT-202609-0001',
      quotationRevision: 1,
      status: 'awaiting_payment',
      paidAmount: 0,
      payments: [],
      taxInvoiceRequested: true,
      taxInvoice: 'no',
      vatAmount: 15.02,
      grandTotal: 229.52,
      remainingTotal: 229.52,
    });
    expect(storedOrder?.quotationId?.toString()).toBe(quotation._id.toString());
    expect(storedOrder?.invoiceNumber).toBeUndefined();
    expect(storedOrder?.bookNo).toBeUndefined();

    const replay = await quotations.convertToOrder(
      quotation._id.toString(),
      { version: 0 },
      actor,
      'quotation-convert-retry-after-success',
    );
    expect(replay.order._id).toBe(storedOrder?._id.toString());
    expect(replay.replayed).toBe(true);
    expect(await orderModel.countDocuments()).toBe(1);
    expect(ordersSse.emitOrder).toHaveBeenCalledTimes(1);
    expect(notificationsService.handleOrderPaymentState).toHaveBeenCalledTimes(
      1,
    );
  });

  it('rolls back quotation conversion when Order creation fails', async () => {
    const quotation = await createApprovedQuotation();
    await orderModel.create({
      _id: new Types.ObjectId(),
      orderId: 'existing-order',
      orderNumber: 'GD-2026-DUPLICATE',
      orderType: 'NORMAL',
      customerName: 'Existing',
      phoneNumber: '',
      total: 1,
      subtotal: 1,
      discount: 0,
      depositTotal: 0,
      paidAmount: 0,
      remainingTotal: 1,
      payment: 'cash',
      paymentMethod: 'cash',
      status: 'awaiting_payment',
      workflowStatus: 'pending',
      saleDate: new Date(),
      entryMode: 'normal',
      isBackdated: false,
      taxInvoice: 'no',
      vatAmount: 0,
      grandTotal: 1,
      payments: [],
      financialAdjustments: [],
      statusHistory: [],
      cart: [],
    });

    const duplicateRunningNumber = {
      generateOrderNumber: jest.fn(() => Promise.resolve('GD-2026-DUPLICATE')),
    } as unknown as RunningNumberService;

    await expect(
      service(duplicateRunningNumber).convertToOrder(
        quotation._id.toString(),
        { version: 0 },
        actor,
        'quotation-convert-rollback',
      ),
    ).rejects.toBeTruthy();

    const storedQuotation = await quotationModel.findById(quotation._id).lean();
    expect(storedQuotation?.status).toBe('APPROVED');
    expect(storedQuotation?.convertedOrderId).toBeUndefined();
    expect(await orderModel.countDocuments()).toBe(1);
    expect(ordersSse.emitOrder).not.toHaveBeenCalled();
    expect(notificationsService.handleOrderPaymentState).not.toHaveBeenCalled();
  });
});
