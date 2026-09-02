import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { RunningNumberService } from '../counters/running-number.service';
import type { CustomerDocument } from '../customers/schemas/customer.schema';
import type { OrderPricingService } from '../orders/order-pricing.service';
import type { OrderDocument } from '../orders/orders.schema';
import type { QuotationDocument, QuotationItem } from './quotation.schema';
import { QuotationsService } from './quotations.service';

const manager: AuthenticatedUser = {
  id: '64b000000000000000000001',
  username: 'manager',
  role: 'manager',
};
const staff: AuthenticatedUser = {
  id: '64b000000000000000000002',
  username: 'staff',
  role: 'staff',
};

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- Mongoose/Jest chainable test doubles are intentionally dynamic in this helper block. */
type MutableQuotation = Record<string, any> & {
  _id: Types.ObjectId;
  __v: number;
  save: jest.Mock;
  toObject: () => Record<string, unknown>;
};

function makeQuotationDoc(
  overrides: Record<string, unknown> = {},
): QuotationDocument {
  const doc = {
    _id: new Types.ObjectId(),
    __v: 0,
    revision: 0,
    status: 'DRAFT',
    createdBy: manager.id,
    updatedBy: manager.id,
    customerSnapshot: { customerName: 'Glossy Customer' },
    items: [],
    subtotal: 0,
    discount: 0,
    taxableAmount: 0,
    vatRate: 7,
    vatAmount: 0,
    grandTotal: 0,
    taxInvoiceRequested: false,
    currency: 'THB',
    statusHistory: [],
    revisionHistory: [],
    ...overrides,
  } as MutableQuotation;
  doc.save = jest.fn(async () => doc);
  doc.toObject = () =>
    Object.fromEntries(
      Object.entries(doc).filter(
        ([key]) => key !== 'save' && key !== 'toObject',
      ),
    );
  return doc as unknown as QuotationDocument;
}

function queryReturning<T>(value: T) {
  const query = {
    session: jest.fn(() => query),
    select: jest.fn(() => query),
    lean: jest.fn(() => query),
    exec: jest.fn(async () => value),
  };
  return query;
}

function createService(
  options: {
    existingQuotation?: QuotationDocument;
    updatedQuotation?: QuotationDocument;
    existingOrder?: OrderDocument | null;
  } = {},
) {
  const createdQuotations: QuotationDocument[] = [];
  const quotationModel = Object.assign(
    jest.fn().mockImplementation((payload: Record<string, unknown>) => {
      const doc = makeQuotationDoc(payload);
      createdQuotations.push(doc);
      return doc;
    }),
    {
      findById: jest.fn(() =>
        queryReturning(options.existingQuotation ?? null),
      ),
      findOneAndUpdate: jest.fn(() =>
        queryReturning(
          options.updatedQuotation ?? options.existingQuotation ?? null,
        ),
      ),
      countDocuments: jest.fn(async () => 0),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({ limit: () => ({ exec: async () => [] }) }),
        }),
      })),
    },
  );

  let createdOrderPayload: Record<string, unknown> | null = null;
  const orderModel = Object.assign(
    jest.fn().mockImplementation((payload: Record<string, unknown>) => {
      createdOrderPayload = payload;
      const order = {
        ...payload,
        _id: payload._id ?? new Types.ObjectId(),
        save: jest.fn(async () => order),
      };
      return order;
    }),
    {
      findById: jest.fn(() => queryReturning(options.existingOrder ?? null)),
    },
  );

  const customerModel = {
    findOne: jest.fn(() => queryReturning(null as CustomerDocument | null)),
  };
  const orderPricing = {
    resolveCart: jest.fn(async () => [
      {
        productId: 'catalog-product-1',
        productCode: 'A4',
        typeCode: 'document',
        name: 'A4 Print',
        qty: 3,
        unitPrice: 10.01,
        totalPrice: 30.03,
        lineTotal: 30.03,
      },
    ]),
  };
  const runningNumber = {
    generateOrderNumber: jest.fn(async () => 'GD-2026-000001'),
    generateQuotationNumber: jest.fn(async () => ({
      quotationNumber: 'QT-202609-0001',
      quotationPeriod: '202609',
      quotationSequence: '0001',
    })),
    generateTaxInvoiceNumber: jest.fn(async () => ({
      invoiceNumber: 'INV-202609-001-001',
      bookNo: '001',
      invoiceSequence: '001',
      invoicePeriod: '202609',
    })),
  };
  const connection = {
    transaction: jest.fn(async (work: (session: object) => Promise<unknown>) =>
      work({ transaction: true }),
    ),
  };

  const service = new QuotationsService(
    quotationModel as never,
    orderModel as never,
    customerModel as never,
    orderPricing as unknown as OrderPricingService,
    runningNumber as unknown as RunningNumberService,
    connection as never,
  );

  return {
    service,
    createdQuotations,
    quotationModel,
    orderModel,
    orderPricing,
    runningNumber,
    getCreatedOrderPayload: () => createdOrderPayload,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */

describe('QuotationsService', () => {
  it('creates a Draft without consuming a quotation number and uses satang-safe VAT money', async () => {
    const { service, createdQuotations, runningNumber } = createService();

    const created = await service.create(
      {
        customerSnapshot: { customerName: 'Customer A' },
        items: [{ productId: 'catalog-product-1', quantity: 3 }],
        discount: { type: 'percent', value: 10 },
        taxInvoiceRequested: true,
      },
      manager,
    );

    expect(created.status).toBe('DRAFT');
    expect(created.quotationNumber).toBeUndefined();
    expect(runningNumber.generateQuotationNumber).not.toHaveBeenCalled();
    expect(created.subtotal).toBe(30.03);
    expect(created.discount).toBe(3);
    expect(created.taxableAmount).toBe(27.03);
    expect(created.vatAmount).toBe(1.89);
    expect(created.grandTotal).toBe(28.92);
    expect(createdQuotations).toHaveLength(1);
  });

  it('allows an incomplete custom-price Draft but blocks Send until an approved price and reason exist', async () => {
    const {
      service,
      createdQuotations,
      quotationModel,
      orderPricing,
      runningNumber,
    } = createService();

    const created = await service.create(
      {
        customerSnapshot: { customerName: 'Customer A' },
        items: [{ customName: 'Custom premium job', quantity: 1 }],
        validUntil: '2026-12-31',
      },
      manager,
    );

    expect(created.items[0]).toMatchObject({
      name: 'Custom premium job',
      authoritativeUnitPrice: 0,
      lineTotal: 0,
    });
    expect(created.items[0].priceOverride).toBeUndefined();
    expect(orderPricing.resolveCart).not.toHaveBeenCalled();

    const draft = createdQuotations[0];
    quotationModel.findById.mockReturnValue(queryReturning(draft));
    await expect(
      service.send(draft._id.toString(), { version: 0 }, manager),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runningNumber.generateQuotationNumber).not.toHaveBeenCalled();
  });

  it('revises an issued quotation immutably while retaining its quotation number', async () => {
    const doc = makeQuotationDoc({
      quotationNumber: 'QT-202609-0001',
      revision: 0,
      status: 'SENT',
      issuedAt: new Date('2026-09-01T03:00:00.000Z'),
      validUntil: new Date('2026-09-10T16:59:59.999Z'),
      items: [
        {
          name: 'Custom print',
          quantity: 1,
          unit: 'งาน',
          authoritativeUnitPrice: 100,
          lineTotal: 100,
          priceOverride: {
            unitPrice: 100,
            reason: 'approved quote',
            approvedBy: manager.id,
            approvedAt: new Date('2026-09-01T02:00:00.000Z'),
          },
        },
      ],
      subtotal: 100,
      taxableAmount: 100,
      grandTotal: 100,
    });
    const { service } = createService({ existingQuotation: doc });

    const revised = await service.revise(
      doc._id.toString(),
      { version: 0, reason: 'ลูกค้าขอแก้สเปก' },
      manager,
    );

    expect(revised.status).toBe('DRAFT');
    expect(revised.revision).toBe(1);
    expect(revised.quotationNumber).toBe('QT-202609-0001');
    expect(revised.issuedAt).toBeUndefined();
    expect(revised.revisionHistory).toHaveLength(1);
    expect(revised.revisionHistory[0]).toMatchObject({
      revision: 0,
      status: 'SENT',
      quotationNumber: 'QT-202609-0001',
    });
  });

  it('requires manager or admin to cancel a Sent quotation', async () => {
    const doc = makeQuotationDoc({
      status: 'SENT',
      validUntil: new Date(Date.now() + 86_400_000),
    });
    const { service } = createService({ existingQuotation: doc });

    await expect(
      service.cancel(
        doc._id.toString(),
        { version: 0, reason: 'ยกเลิก' },
        staff,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns a structured conflict when catalog price changed after approval', async () => {
    const doc = makeQuotationDoc({
      quotationNumber: 'QT-202609-0002',
      revision: 0,
      status: 'APPROVED',
      items: [
        {
          productId: 'catalog-product-1',
          productCode: 'A4',
          typeCode: 'document',
          name: 'A4 Print',
          quantity: 1,
          unit: 'แผ่น',
          authoritativeUnitPrice: 100,
          lineTotal: 100,
        },
      ],
      subtotal: 100,
      discount: 0,
      taxableAmount: 100,
      vatAmount: 0,
      grandTotal: 100,
      taxInvoiceRequested: false,
    });
    const { service, getCreatedOrderPayload } = createService({
      existingQuotation: doc,
    });

    let caught: unknown;
    try {
      await service.convertToOrder(
        doc._id.toString(),
        { version: 0 },
        manager,
        'price-conflict',
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).getResponse()).toMatchObject({
      code: 'QUOTATION_PRICE_CONFLICT',
      conflicts: [
        {
          index: 0,
          quotedUnitPrice: 100,
          currentUnitPrice: 10.01,
        },
      ],
    });
    expect(getCreatedOrderPayload()).toBeNull();
  });

  it('does not allow staff to force an approved quoted price through a conversion conflict', async () => {
    const doc = makeQuotationDoc({
      quotationNumber: 'QT-202609-0003',
      revision: 0,
      status: 'APPROVED',
      items: [
        {
          productId: 'catalog-product-1',
          productCode: 'A4',
          typeCode: 'document',
          name: 'A4 Print',
          quantity: 1,
          unit: 'แผ่น',
          authoritativeUnitPrice: 100,
          lineTotal: 100,
        },
      ],
      subtotal: 100,
      discount: 0,
      taxableAmount: 100,
      vatAmount: 0,
      grandTotal: 100,
      taxInvoiceRequested: false,
    });
    const { service } = createService({ existingQuotation: doc });

    await expect(
      service.convertToOrder(
        doc._id.toString(),
        {
          version: 0,
          confirmQuotedPrice: true,
          priceConflictReason: 'Use approved quotation price',
        },
        staff,
        'price-conflict-staff',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('converts an Approved quotation to an unpaid Order without issuing tax invoice identity', async () => {
    const item: QuotationItem = {
      name: 'Custom print',
      quantity: 2,
      unit: 'งาน',
      authoritativeUnitPrice: 107.25,
      lineTotal: 214.5,
      priceOverride: {
        unitPrice: 107.25,
        reason: 'Manager approved custom job',
        approvedBy: manager.id,
        approvedAt: new Date('2026-09-01T02:00:00.000Z'),
      },
    };
    const doc = makeQuotationDoc({
      quotationNumber: 'QT-202609-0001',
      revision: 1,
      status: 'APPROVED',
      customerSnapshot: {
        customerName: 'Approved Customer',
        phoneNumber: '0812345678',
      },
      items: [item],
      subtotal: 214.5,
      discount: 0,
      taxableAmount: 214.5,
      vatRate: 7,
      vatAmount: 15.02,
      grandTotal: 229.52,
      taxInvoiceRequested: true,
    });
    const updated = makeQuotationDoc({
      ...doc.toObject(),
      status: 'CONVERTED',
      convertedOrderId: new Types.ObjectId(),
      convertedAt: new Date(),
      convertedBy: manager.id,
      __v: 1,
    });
    const { service, runningNumber, getCreatedOrderPayload } = createService({
      existingQuotation: doc,
      updatedQuotation: updated,
    });

    const result = await service.convertToOrder(
      doc._id.toString(),
      { version: 0 },
      manager,
      'convert-1',
    );

    const payload = getCreatedOrderPayload();
    expect(payload).toBeTruthy();
    expect(payload).toMatchObject({
      quotationNumber: 'QT-202609-0001',
      quotationRevision: 1,
      status: 'awaiting_payment',
      paidAmount: 0,
      depositTotal: 0,
      remainingTotal: 229.52,
      grandTotal: 229.52,
      payments: [],
      taxInvoiceRequested: true,
      taxInvoice: 'no',
    });
    expect(payload).not.toHaveProperty('invoiceNumber');
    expect(payload).not.toHaveProperty('bookNo');
    expect(payload).not.toHaveProperty('invoiceSequence');
    expect(payload).not.toHaveProperty('invoicePeriod');
    expect(runningNumber.generateTaxInvoiceNumber).not.toHaveBeenCalled();
    expect(result.order.orderNumber).toBe('GD-2026-000001');
    expect(result.replayed).toBe(false);
  });
});
