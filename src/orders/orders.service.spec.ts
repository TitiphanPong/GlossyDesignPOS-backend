import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import type { OrderDocument, OrderStatus } from './orders.schema';
import { OrdersSseService } from './orders.sse.service';
import { OrdersService } from './orders.service';
import { OrderPricingService } from './order-pricing.service';
import { OrderReportingService } from './order-reporting.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { OrderResponseDto } from './dto/order-response.dto';

type FindByIdAndUpdateArgs = [
  string,
  Record<string, unknown>,
  Record<string, unknown>,
];

type OrderModelLike = {
  findById: (id: string) => {
    exec: () => Promise<unknown>;
  };
  findByIdAndUpdate: (...args: FindByIdAndUpdateArgs) => {
    exec: () => Promise<unknown>;
  };
  findOneAndUpdate: (...args: unknown[]) => {
    exec: () => Promise<unknown>;
  };
};

describe('OrdersService', () => {
  const validOrderId = '61a1c287e53a7024d4ab8142';
  const runningNumberService = {
    generateOrderNumber: jest.fn(),
  } as unknown as RunningNumberService;

  const ordersSse = {
    emitOrder: jest.fn(),
    emitOrderAndAutoClear: jest.fn(),
  } as unknown as OrdersSseService;

  const orderPricing = {
    resolveCart: jest.fn((_orderType, cart: Array<Record<string, unknown>>) =>
      Promise.resolve(
        cart.map((item) => ({
          name: 'Item',
          qty: Number(item.quantity),
          unitPrice: 100,
          totalPrice: Number(item.quantity) * 100,
          lineTotal: Number(item.quantity) * 100,
        })),
      ),
    ),
  } as unknown as OrderPricingService;

  const handleOrderStatusChange = jest.fn().mockResolvedValue(undefined);
  const notificationsService = {
    autoResolvePaymentNotifications: jest.fn().mockResolvedValue(undefined),
    createNotification: jest.fn().mockResolvedValue(undefined),
    handleOrderPaymentState: jest.fn().mockResolvedValue(undefined),
    handleOrderStatusChange,
  } as unknown as NotificationsService;

  let findById: jest.MockedFunction<OrderModelLike['findById']>;
  let findByIdAndUpdate: jest.MockedFunction<
    OrderModelLike['findByIdAndUpdate']
  >;
  let findOneAndUpdate: jest.MockedFunction<OrderModelLike['findOneAndUpdate']>;
  let service: OrdersService;

  beforeEach(() => {
    jest.clearAllMocks();
    findById = jest.fn();
    findByIdAndUpdate = jest.fn();
    findOneAndUpdate = jest.fn();

    const orderModel: OrderModelLike = {
      findById,
      findByIdAndUpdate,
      findOneAndUpdate,
    };

    service = new OrdersService(
      orderModel as unknown as Model<OrderDocument>,
      runningNumberService,
      ordersSse,
      orderPricing,
      undefined as unknown as OrderReportingService,
      notificationsService,
      {} as Connection,
    );
  });

  const makeWorkflowOrder = (
    workflowStatus:
      | 'pending'
      | 'producing'
      | 'ready_for_pickup'
      | 'delivered'
      | 'cancelled',
    financialStatus: OrderStatus = 'partial',
  ) => {
    const plain = {
      orderId: validOrderId,
      orderNumber: 'GL-20260829-0001',
      customerName: 'Workflow Customer',
      phoneNumber: '0812345678',
      note: '',
      total: 100,
      subtotal: 100,
      discount: 0,
      depositTotal: 50,
      paidAmount: 50,
      remainingTotal: 50,
      payment: 'cash',
      paymentMethod: 'cash',
      status: financialStatus,
      workflowStatus,
      taxInvoice: 'no',
      vatAmount: 0,
      grandTotal: 100,
      payments: [],
      statusHistory: [{ status: workflowStatus, changedAt: new Date() }],
      cart: [],
      createdAt: new Date('2026-08-29T00:00:00.000Z'),
      updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    };
    return {
      _id: { toString: () => validOrderId },
      workflowStatus,
      status: financialStatus,
      toObject: () => plain,
    } as unknown as OrderDocument;
  };

  it('forwards complete order context to status notifications', () => {
    const response = {
      _id: validOrderId,
      orderNumber: 'GL-20260825-0001',
      customerName: 'Test customer',
      status: 'ready_for_pickup',
    } as OrderResponseDto;

    (
      service as unknown as {
        emitForStatus(response: OrderResponseDto, status: OrderStatus): void;
      }
    ).emitForStatus(response, 'ready_for_pickup');

    expect(handleOrderStatusChange).toHaveBeenCalledWith({
      _id: validOrderId,
      status: 'ready_for_pickup',
      orderNumber: 'GL-20260825-0001',
      customerName: 'Test customer',
    });
  });

  it('updates only invoice customer fields and mirrors legacy aliases', async () => {
    const updatedAt = new Date('2026-05-31T00:00:00.000Z');
    const createdAt = new Date('2026-05-30T00:00:00.000Z');
    const updatedOrder = {
      _id: { toString: () => validOrderId },
      toObject: () => ({
        orderId: validOrderId,
        orderNumber: 'GL-20260531-0001',
        customerName: 'Sarayut 111',
        phoneNumber: '0812345678',
        note: 'keep original',
        total: 1200,
        discount: 0,
        depositTotal: 0,
        remainingTotal: 1200,
        payment: 'cash',
        status: 'pending',
        taxInvoice: 'yes',
        vatAmount: 78.5,
        grandTotal: 1278.5,
        payments: [],
        cart: [{ name: 'Card', qty: 1, unitPrice: 1200, totalPrice: 1200 }],
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        createdAt,
        updatedAt,
      }),
    };

    findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(updatedOrder),
    });

    const result = await service.updateCustomerInfo(validOrderId, {
      customerName: 'Sarayut 111',
      taxId: '0123456789012',
      address: '88/8 Moo Baan Klang Muang',
    });

    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      validOrderId,
      {
        customerName: 'Sarayut 111',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
      },
      { new: true, runValidators: true },
    );
    expect(result).toEqual(
      expect.objectContaining({
        _id: validOrderId,
        customerName: 'Sarayut 111',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
        total: 1200,
        status: 'pending',
      }),
    );
  });

  it('defaults normal orders to the current sale date', async () => {
    const result = await (
      service as unknown as {
        normalizeOrderForCreate: (
          order: Record<string, unknown>,
          role?: 'admin',
        ) => Promise<Record<string, unknown>>;
      }
    ).normalizeOrderForCreate(
      {
        cart: [
          {
            customName: 'Item',
            quantity: 1,
            priceOverride: { unitPrice: 100, reason: 'test' },
          },
        ],
      },
      'admin',
    );

    expect(result.entryMode).toBe('normal');
    expect(result.isBackdated).toBe(false);
    expect(result.saleDate).toBeInstanceOf(Date);
    expect((result.saleDate as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('accepts a past sale date and rejects a future sale date', async () => {
    const normalize = (saleDate: string) =>
      (
        service as unknown as {
          normalizeOrderForCreate: (
            order: Record<string, unknown>,
            role?: 'admin',
          ) => Promise<Record<string, unknown>>;
        }
      ).normalizeOrderForCreate(
        {
          entryMode: 'backdated',
          saleDate,
          backdatedReason: 'ตกหล่น',
          cart: [
            {
              customName: 'Item',
              quantity: 1,
              priceOverride: { unitPrice: 100, reason: 'test' },
            },
          ],
        },
        'admin',
      );

    const result = await normalize('2026-08-18T14:30:00.000Z');
    expect(result.entryMode).toBe('backdated');
    expect(result.isBackdated).toBe(true);
    expect(result.saleDate).toEqual(new Date('2026-08-18T14:30:00.000Z'));
    expect(result.backdatedReason).toBe('ตกหล่น');

    await expect(normalize('2999-01-01T00:00:00.000Z')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('derives authoritative totals and status instead of copying tampered fields', async () => {
    const result = await (
      service as unknown as {
        normalizeOrderForCreate: (
          order: Record<string, unknown>,
          role?: 'admin',
        ) => Promise<Record<string, unknown>>;
      }
    ).normalizeOrderForCreate(
      {
        cart: [
          {
            customName: 'Item',
            quantity: 1,
            priceOverride: { unitPrice: 1, reason: 'ignored by pricing stub' },
          },
        ],
        discount: { type: 'amount', value: 10 },
        initialPayment: { amount: 40, method: 'cash', receivedAmount: 50 },
        taxInvoice: 'yes',
        subtotal: 1,
        grandTotal: 1,
        paidAmount: 1,
        remainingTotal: 0,
        status: 'paid',
      },
      'admin',
    );

    expect(result).toEqual(
      expect.objectContaining({
        total: 100,
        subtotal: 100,
        discount: 10,
        vatAmount: 6.3,
        grandTotal: 96.3,
        paidAmount: 40,
        remainingTotal: 56.3,
        receivedAmount: 50,
        changeAmount: 10,
        status: 'partial',
      }),
    );
  });

  it.each(['awaiting_payment', 'partial', 'paid'] as const)(
    'rejects direct workflow writes to financial status %s',
    async (status) => {
      await expect(
        service.updateStatus(validOrderId, status),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findByIdAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('advances exactly one workflow step without overwriting financial status and records actor', async () => {
    const current = makeWorkflowOrder('pending', 'partial');
    const updated = makeWorkflowOrder('producing', 'partial');
    findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(current),
    });
    findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(updated),
    });

    const result = await service.updateStatus(
      validOrderId,
      'producing',
      'เริ่มผลิต',
      { id: 'user-123' },
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: 'partial',
        workflowStatus: 'producing',
      }),
    );
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { _id: validOrderId, workflowStatus: 'pending' },
      {
        $set: { workflowStatus: 'producing' },
        $push: {
          statusHistory: {
            status: 'producing',
            note: 'เริ่มผลิต',
            changedAt: expect.any(Date) as Date,
            changedBy: 'user-123',
          },
        },
      },
      { new: true, runValidators: true },
    );
  });

  it.each([
    ['pending', 'ready_for_pickup'],
    ['pending', 'delivered'],
    ['producing', 'pending'],
    ['ready_for_pickup', 'producing'],
    ['delivered', 'ready_for_pickup'],
  ] as const)(
    'rejects invalid production workflow transition %s -> %s',
    async (currentStatus, targetStatus) => {
      findById.mockReturnValue({
        exec: jest.fn().mockResolvedValue(makeWorkflowOrder(currentStatus)),
      });

      await expect(
        service.updateStatus(validOrderId, targetStatus),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('treats same-state workflow retry as idempotent without appending history', async () => {
    const existing = makeWorkflowOrder('producing');
    findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(existing),
    });

    const result = await service.updateStatus(
      validOrderId,
      'producing',
      'retry',
      { id: 'user-123' },
    );

    expect(result).toEqual(
      expect.objectContaining({ workflowStatus: 'producing' }),
    );
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('fails a transition when the atomic current-state predicate loses a race', async () => {
    findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(makeWorkflowOrder('pending')),
    });
    findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.updateStatus(validOrderId, 'producing'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses the same transition guard for generic PATCH with customer fields', async () => {
    findById.mockReturnValue({
      exec: jest.fn().mockResolvedValue(makeWorkflowOrder('pending')),
    });

    await expect(
      service.updateOrder(
        validOrderId,
        { customerName: 'Updated', status: 'ready_for_pickup' },
        { id: 'user-123' },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects cancellation through the generic workflow status route', async () => {
    await expect(
      service.updateStatus(validOrderId, 'cancelled', 'reason', {
        id: 'user-123',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findById).not.toHaveBeenCalled();
  });

  it('cancels without deleting and appends refund facts for collected payments', async () => {
    const paymentDate = new Date('2026-08-30T01:00:00.000Z');
    const currentPlain = {
      orderId: validOrderId,
      orderNumber: 'GL-20260830-0001',
      customerName: 'Cancel Customer',
      phoneNumber: '0812345678',
      note: '',
      total: 100,
      subtotal: 100,
      discount: 0,
      depositTotal: 50,
      paidAmount: 50,
      remainingTotal: 50,
      payment: 'cash' as const,
      paymentMethod: 'cash' as const,
      status: 'partial' as const,
      workflowStatus: 'producing' as const,
      taxInvoice: 'yes' as const,
      invoiceNumber: 'INV-001',
      vatAmount: 0,
      grandTotal: 100,
      payments: [
        {
          amount: 50,
          method: 'cash' as const,
          idempotencyKey: 'pay-1',
          paidAt: paymentDate,
        },
      ],
      financialAdjustments: [],
      statusHistory: [{ status: 'producing' as const, changedAt: paymentDate }],
      cart: [],
      createdAt: paymentDate,
      updatedAt: paymentDate,
    };
    const current = {
      _id: { toString: () => validOrderId },
      ...currentPlain,
      toObject: () => currentPlain,
    } as unknown as OrderDocument;
    const updatedPlain = {
      ...currentPlain,
      status: 'cancelled' as const,
      workflowStatus: 'cancelled' as const,
      remainingTotal: 0,
      cancellation: {
        reason: 'ลูกค้ายกเลิก',
        cancelledAt: new Date(),
        cancelledBy: 'user-123',
        refundedAmount: 50,
        correctiveDocumentRequired: true,
        correctiveDocumentStatus: 'required' as const,
      },
    };
    const updated = {
      _id: { toString: () => validOrderId },
      ...updatedPlain,
      toObject: () => updatedPlain,
    } as unknown as OrderDocument;
    findById.mockReturnValue({ exec: jest.fn().mockResolvedValue(current) });
    findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(updated),
    });

    const result = await service.cancelOrder(validOrderId, ' ลูกค้ายกเลิก ', {
      id: 'user-123',
    });

    expect(result.status).toBe('cancelled');
    expect(result.cancellation).toEqual(
      expect.objectContaining({
        refundedAmount: 50,
        correctiveDocumentRequired: true,
      }),
    );
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: validOrderId,
        workflowStatus: 'producing',
        status: 'partial',
        paidAmount: 50,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'cancelled',
          workflowStatus: 'cancelled',
          remainingTotal: 0,
        }) as unknown,
        $push: expect.objectContaining({
          financialAdjustments: expect.objectContaining({
            $each: [
              expect.objectContaining({
                type: 'refund',
                amount: -50,
                method: 'cash',
                reason: 'ลูกค้ายกเลิก',
                changedBy: 'user-123',
                sourcePaymentIdempotencyKey: 'pay-1',
              }),
            ],
          }) as unknown,
        }) as unknown,
      }),
      { new: true, runValidators: true },
    );
  });

  it('returns the concurrently cancelled order instead of duplicating refund facts', async () => {
    const basePlain = {
      orderId: validOrderId,
      orderNumber: 'GL-20260830-0002',
      customerName: 'Concurrent Cancel',
      phoneNumber: '0812345678',
      note: '',
      total: 100,
      subtotal: 100,
      discount: 0,
      depositTotal: 0,
      paidAmount: 0,
      remainingTotal: 100,
      payment: 'cash' as const,
      paymentMethod: 'cash' as const,
      status: 'pending' as const,
      workflowStatus: 'pending' as const,
      taxInvoice: 'no' as const,
      vatAmount: 0,
      grandTotal: 100,
      payments: [],
      financialAdjustments: [],
      statusHistory: [],
      cart: [],
      createdAt: new Date('2026-08-30T01:00:00.000Z'),
      updatedAt: new Date('2026-08-30T01:00:00.000Z'),
    };
    const existing = {
      _id: { toString: () => validOrderId },
      ...basePlain,
      toObject: () => basePlain,
    } as unknown as OrderDocument;
    const cancelledPlain = {
      ...basePlain,
      status: 'cancelled' as const,
      workflowStatus: 'cancelled' as const,
      remainingTotal: 0,
      cancellation: {
        reason: 'ลูกค้ายกเลิก',
        cancelledAt: new Date(),
        cancelledBy: 'other-user',
        refundedAmount: 0,
        correctiveDocumentRequired: false,
        correctiveDocumentStatus: 'not_required' as const,
      },
    };
    const concurrentlyCancelled = {
      _id: { toString: () => validOrderId },
      ...cancelledPlain,
      toObject: () => cancelledPlain,
    } as unknown as OrderDocument;
    findById
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(existing) })
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue(concurrentlyCancelled),
      });
    findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    const result = await service.cancelOrder(validOrderId, 'ลูกค้ายกเลิก', {
      id: 'user-123',
    });

    expect(result.status).toBe('cancelled');
    expect(result.cancellation?.cancelledBy).toBe('other-user');
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it.each(['awaiting_payment', 'partial', 'paid'] as const)(
    'rejects generic PATCH bypass to financial status %s when customer fields are also present',
    async (status) => {
      await expect(
        service.updateOrder(validOrderId, {
          customerName: 'Attempted bypass',
          status,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findByIdAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('rejects a discount greater than the server-priced subtotal', async () => {
    await expect(
      (
        service as unknown as {
          normalizeOrderForCreate: (
            order: Record<string, unknown>,
            role?: 'admin',
          ) => Promise<Record<string, unknown>>;
        }
      ).normalizeOrderForCreate(
        {
          cart: [
            {
              customName: 'Item',
              quantity: 1,
              priceOverride: { unitPrice: 100, reason: 'test' },
            },
          ],
          discount: { type: 'amount', value: 100.01 },
        },
        'admin',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws 404 when order does not exist', async () => {
    findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.updateCustomerInfo(validOrderId, {
        customerName: 'Missing Customer',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 400 when mirrored fields conflict', async () => {
    await expect(
      service.updateCustomerInfo(validOrderId, {
        taxId: '0123456789012',
        customerTaxId: '9999999999999',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
