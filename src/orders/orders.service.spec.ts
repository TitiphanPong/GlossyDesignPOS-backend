import { BadRequestException, NotFoundException } from '@nestjs/common';
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
  findByIdAndUpdate: (...args: FindByIdAndUpdateArgs) => {
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

  let findByIdAndUpdate: jest.MockedFunction<
    OrderModelLike['findByIdAndUpdate']
  >;
  let service: OrdersService;

  beforeEach(() => {
    jest.clearAllMocks();
    findByIdAndUpdate = jest.fn();

    const orderModel: OrderModelLike = {
      findByIdAndUpdate,
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
