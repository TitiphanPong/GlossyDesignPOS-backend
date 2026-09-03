import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, createConnection } from 'mongoose';
import {
  Counter,
  CounterDocument,
  CounterSchema,
  COUNTER_TYPE_TAX_INVOICE,
} from '../counters/counters.schema';
import { RunningNumberService } from '../counters/running-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderPricingService } from './order-pricing.service';
import { OrderReportingService } from './order-reporting.service';
import { Order, OrderDocument, OrderSchema } from './orders.schema';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';

jest.setTimeout(120_000);

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === '1' ? describe : describe.skip;

function makeService(
  orderModel: Model<OrderDocument>,
  runningNumberService: RunningNumberService,
  connection: Connection,
): OrdersService {
  const ordersSse = {
    emitOrder: jest.fn(),
    emitOrderAndAutoClear: jest.fn(),
  } as unknown as OrdersSseService;
  const notificationsService = {
    autoResolvePaymentNotifications: jest.fn().mockResolvedValue(undefined),
    handleOrderPaymentState: jest.fn().mockResolvedValue(undefined),
    handleOrderStatusChange: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;

  return new OrdersService(
    orderModel,
    runningNumberService,
    ordersSse,
    {} as OrderPricingService,
    undefined as unknown as OrderReportingService,
    notificationsService,
    connection,
  );
}

describeMongo(
  'OrdersService tax invoice conversion against replica-set MongoDB',
  () => {
    let replSet: MongoMemoryReplSet;
    let connection: Connection;
    let orderModel: Model<OrderDocument>;
    let counterModel: Model<CounterDocument>;
    let service: OrdersService;

    beforeAll(async () => {
      replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
      });
      connection = createConnection(replSet.getUri(), {
        dbName: 'glossy-tax-invoice-integrity',
      });
      await connection.asPromise();
      orderModel = connection.model(
        Order.name,
        OrderSchema,
      ) as unknown as Model<OrderDocument>;
      counterModel = connection.model(
        Counter.name,
        CounterSchema,
      ) as unknown as Model<CounterDocument>;
      await Promise.all([orderModel.syncIndexes(), counterModel.syncIndexes()]);
      service = makeService(
        orderModel,
        new RunningNumberService(counterModel),
        connection,
      );
    });

    afterAll(async () => {
      await connection?.close();
      await replSet?.stop();
    });

    beforeEach(async () => {
      await Promise.all([
        orderModel.deleteMany({}),
        counterModel.deleteMany({}),
      ]);
    });

    async function createRegularOrder(
      overrides: Record<string, unknown> = {},
    ): Promise<OrderDocument> {
      return orderModel.create({
        orderType: 'NORMAL',
        orderId: randomUUID(),
        orderNumber: `TAX-${randomUUID()}`,
        customerName: 'Tax invoice customer',
        phoneNumber: '0812345678',
        note: '',
        saleDate: new Date('2026-08-27T00:00:00.000Z'),
        total: 100,
        subtotal: 100,
        discount: 0,
        depositTotal: 0,
        paidAmount: 0,
        remainingTotal: 100,
        payment: 'cash',
        paymentMethod: 'cash',
        status: 'awaiting_payment',
        taxInvoice: 'no',
        vatAmount: 0,
        grandTotal: 100,
        payments: [],
        statusHistory: [],
        cart: [],
        ...overrides,
      });
    }

    it('allocates one invoice identity when five conversions race', async () => {
      const order = await createRegularOrder();

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          service.convertToTaxInvoice(order._id.toString()),
        ),
      );

      const stored = await orderModel.findById(order._id).lean().exec();
      const counter = await counterModel
        .findOne({ type: COUNTER_TYPE_TAX_INVOICE, year: 202608 })
        .lean()
        .exec();

      expect(new Set(results.map((result) => result.invoiceNumber))).toEqual(
        new Set(['INV-202608-001-001']),
      );
      expect(counter?.seq).toBe(1);
      expect(stored?.invoiceNumber).toBe('INV-202608-001-001');
      expect(stored?.bookNo).toBe('001');
      expect(stored?.invoiceSequence).toBe('001');
      expect(stored?.invoicePeriod).toBe('202608');
      expect(stored?.taxInvoice).toBe('yes');
      expect(stored?.vatAmount).toBe(7);
      expect(stored?.grandTotal).toBe(107);
      expect(stored?.remainingTotal).toBe(107);
      expect(stored?.status).toBe('awaiting_payment');
    });

    it('keeps a cancelled issued invoice consumed and gives the replacement order the next number', async () => {
      const cancelledOrder = await createRegularOrder({
        saleDate: new Date('2026-09-03T03:00:00.000Z'),
      });
      const issued = await service.convertToTaxInvoice(
        cancelledOrder._id.toString(),
      );

      expect(issued.invoiceNumber).toBe('INV-202609-001-001');
      expect(issued.invoiceSequence).toBe('001');

      const cancelled = await service.cancelOrder(
        cancelledOrder._id.toString(),
        'ยกเลิกเพื่อเปิด Order ใหม่',
        { id: 'manager-1' },
      );

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.invoiceNumber).toBe('INV-202609-001-001');
      expect(cancelled.invoiceSequence).toBe('001');
      expect(cancelled.cancellation?.correctiveDocumentRequired).toBe(true);

      const replacementOrder = await createRegularOrder({
        saleDate: new Date('2026-09-03T03:05:00.000Z'),
      });
      const replacement = await service.convertToTaxInvoice(
        replacementOrder._id.toString(),
      );
      const counter = await counterModel
        .findOne({ type: COUNTER_TYPE_TAX_INVOICE, year: 202609 })
        .lean()
        .exec();

      expect(replacement.invoiceNumber).toBe('INV-202609-001-002');
      expect(replacement.invoiceSequence).toBe('002');
      expect(counter?.seq).toBe(2);

      const storedCancelled = await orderModel
        .findById(cancelledOrder._id)
        .lean()
        .exec();
      expect(storedCancelled?.invoiceNumber).toBe('INV-202609-001-001');
      expect(storedCancelled?.invoiceSequence).toBe('001');
    });

    it('rolls the counter allocation back when the order update cannot commit', async () => {
      await createRegularOrder({
        orderNumber: `BLOCKER-${randomUUID()}`,
        taxInvoice: 'yes',
        invoiceNumber: 'INV-202608-001-001',
        bookNo: '001',
        invoiceSequence: '001',
        invoicePeriod: '202608',
        vatAmount: 7,
        grandTotal: 107,
        remainingTotal: 107,
      });
      const target = await createRegularOrder();

      await expect(
        service.convertToTaxInvoice(target._id.toString()),
      ).rejects.toBeDefined();

      expect(
        await counterModel
          .findOne({ type: COUNTER_TYPE_TAX_INVOICE, year: 202608 })
          .lean()
          .exec(),
      ).toBeNull();

      await orderModel.deleteOne({ invoiceNumber: 'INV-202608-001-001' });
      const recovered = await service.convertToTaxInvoice(
        target._id.toString(),
      );
      const counter = await counterModel
        .findOne({ type: COUNTER_TYPE_TAX_INVOICE, year: 202608 })
        .lean()
        .exec();

      expect(recovered.invoiceNumber).toBe('INV-202608-001-001');
      expect(counter?.seq).toBe(1);
    });

    it('continues the September book and invoice sequence into October', async () => {
      await counterModel.create({
        type: COUNTER_TYPE_TAX_INVOICE,
        year: 202609,
        seq: 99,
      });
      const septemberOrder = await createRegularOrder({
        saleDate: new Date('2026-09-30T16:59:59.000Z'),
      });
      const octoberOrder = await createRegularOrder({
        saleDate: new Date('2026-09-30T17:00:00.000Z'),
      });

      const septemberInvoice = await service.convertToTaxInvoice(
        septemberOrder._id.toString(),
      );
      const octoberInvoice = await service.convertToTaxInvoice(
        octoberOrder._id.toString(),
      );
      const counter = await counterModel
        .findOne({ type: COUNTER_TYPE_TAX_INVOICE, year: 202609 })
        .lean()
        .exec();

      expect(septemberInvoice.invoiceNumber).toBe('INV-202609-001-100');
      expect(septemberInvoice.bookNo).toBe('001');
      expect(septemberInvoice.invoiceSequence).toBe('100');
      expect(octoberInvoice.invoiceNumber).toBe('INV-202610-002-001');
      expect(octoberInvoice.bookNo).toBe('002');
      expect(octoberInvoice.invoiceSequence).toBe('001');
      expect(counter?.seq).toBe(101);
      expect(
        await counterModel.countDocuments({
          type: COUNTER_TYPE_TAX_INVOICE,
        }),
      ).toBe(1);
    });

    it('blocks partial legacy invoice identity instead of mixing two allocations', async () => {
      const order = await createRegularOrder({
        invoiceNumber: 'LEGACY-PARTIAL-001',
      });

      await expect(
        service.convertToTaxInvoice(order._id.toString()),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(await counterModel.countDocuments({})).toBe(0);
      const stored = await orderModel.findById(order._id).lean().exec();
      expect(stored?.invoiceNumber).toBe('LEGACY-PARTIAL-001');
      expect(stored?.taxInvoice).toBe('no');
    });
  },
);
