import { BadRequestException, ConflictException } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderPricingService } from './order-pricing.service';
import { OrderReportingService } from './order-reporting.service';
import type {
  OrderDocument,
  OrderStatus,
  PaymentMethod,
} from './orders.schema';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';

type PaymentFact = {
  amount: number;
  method: PaymentMethod;
  note?: string;
  idempotencyKey?: string;
  paidAt: Date;
};

type StatusFact = {
  status: OrderStatus;
  note?: string;
  changedAt: Date;
};

type AtomicOrderState = {
  orderType: 'NORMAL';
  orderId: string;
  orderNumber: string;
  customerName: string;
  phoneNumber: string;
  note: string;
  total: number;
  subtotal: number;
  discount: number;
  depositTotal: number;
  paidAmount: number;
  remainingTotal: number;
  payment: PaymentMethod;
  status: OrderStatus;
  taxInvoice: 'no';
  vatAmount: number;
  grandTotal: number;
  payments: PaymentFact[];
  statusHistory: StatusFact[];
  cart: unknown[];
  createdAt: Date;
  updatedAt: Date;
};

type AtomicPaymentFilter = {
  _id: string;
  paidAmount: number;
  grandTotal: number;
  remainingTotal: {
    $eq: number;
    $gte: number;
  };
  'payments.idempotencyKey'?: { $ne: string };
};

type AtomicPaymentUpdate = {
  $set: {
    depositTotal: number;
    paidAmount: number;
    remainingTotal: number;
    status: OrderStatus;
  };
  $push: {
    payments: PaymentFact;
    statusHistory: StatusFact;
  };
};

function cloneState(state: AtomicOrderState): AtomicOrderState {
  return {
    ...state,
    payments: state.payments.map((payment) => ({ ...payment })),
    statusHistory: state.statusHistory.map((history) => ({ ...history })),
    cart: [...state.cart],
  };
}

function makeOrderDocument(
  id: string,
  snapshot: AtomicOrderState,
): OrderDocument {
  return {
    ...cloneState(snapshot),
    _id: { toString: () => id },
    toObject: () => cloneState(snapshot),
  } as unknown as OrderDocument;
}

function makeAtomicOrderModel(options?: {
  grandTotal?: number;
  paidAmount?: number;
  remainingTotal?: number;
  payments?: PaymentFact[];
  concurrentReaders?: number;
}) {
  const id = '61a1c287e53a7024d4ab8142';
  const grandTotal = options?.grandTotal ?? 100;
  const paidAmount = options?.paidAmount ?? 0;
  const now = new Date('2026-08-27T00:00:00.000Z');
  const initialPayments =
    options?.payments ??
    (paidAmount > 0
      ? [{ amount: paidAmount, method: 'cash' as const, paidAt: now }]
      : []);
  let state: AtomicOrderState = {
    orderType: 'NORMAL',
    orderId: id,
    orderNumber: 'GL-20260827-0001',
    customerName: 'Concurrent customer',
    phoneNumber: '0812345678',
    note: '',
    total: grandTotal,
    subtotal: grandTotal,
    discount: 0,
    depositTotal: paidAmount,
    paidAmount,
    remainingTotal: options?.remainingTotal ?? grandTotal - paidAmount,
    payment: 'cash',
    status:
      paidAmount === 0
        ? 'awaiting_payment'
        : paidAmount === grandTotal
          ? 'paid'
          : 'partial',
    taxInvoice: 'no',
    vatAmount: 0,
    grandTotal,
    payments: initialPayments.map((payment) => ({ ...payment })),
    statusHistory: [],
    cart: [],
    createdAt: now,
    updatedAt: now,
  };

  const concurrentReaders = options?.concurrentReaders ?? 0;
  let waitingReaders = 0;
  let releaseReaders: (() => void) | undefined;
  const readerBarrier = new Promise<void>((resolve) => {
    releaseReaders = resolve;
  });

  const model = {
    findById: jest.fn((requestedId: string) => ({
      exec: async () => {
        expect(requestedId).toBe(id);
        const snapshot = cloneState(state);
        if (waitingReaders < concurrentReaders) {
          waitingReaders += 1;
          if (waitingReaders === concurrentReaders) {
            releaseReaders?.();
          }
          await readerBarrier;
        }
        return makeOrderDocument(id, snapshot);
      },
    })),
    findOneAndUpdate: jest.fn(
      (filter: AtomicPaymentFilter, update: AtomicPaymentUpdate) => ({
        exec: () => {
          const idempotencyFilter = filter['payments.idempotencyKey'];
          const idempotencyMatches =
            !idempotencyFilter ||
            !state.payments.some(
              (payment) => payment.idempotencyKey === idempotencyFilter.$ne,
            );
          const matches =
            filter._id === id &&
            state.paidAmount === filter.paidAmount &&
            state.grandTotal === filter.grandTotal &&
            state.remainingTotal === filter.remainingTotal.$eq &&
            state.remainingTotal >= filter.remainingTotal.$gte &&
            idempotencyMatches;

          if (!matches) return null;

          state = {
            ...state,
            ...update.$set,
            payments: [...state.payments, { ...update.$push.payments }],
            statusHistory: [
              ...state.statusHistory,
              { ...update.$push.statusHistory },
            ],
            updatedAt: new Date(),
          };
          return makeOrderDocument(id, cloneState(state));
        },
      }),
    ),
  };

  return {
    id,
    model: model as unknown as Model<OrderDocument>,
    getState: () => cloneState(state),
  };
}

function makeService(orderModel: Model<OrderDocument>) {
  const runningNumberService = {} as RunningNumberService;
  const ordersSse = {
    emitOrder: jest.fn(),
    emitOrderAndAutoClear: jest.fn(),
  } as unknown as OrdersSseService;
  const orderPricing = {} as OrderPricingService;
  const notificationsService = {
    autoResolvePaymentNotifications: jest.fn().mockResolvedValue(undefined),
    handleOrderPaymentState: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;

  return new OrdersService(
    orderModel,
    runningNumberService,
    ordersSse,
    orderPricing,
    undefined as unknown as OrderReportingService,
    notificationsService,
    {} as Connection,
  );
}

describe('OrdersService addPayment atomicity', () => {
  it('preserves both payment facts when two valid payments race', async () => {
    const store = makeAtomicOrderModel({ concurrentReaders: 2 });
    const service = makeService(store.model);

    const results = await Promise.all([
      service.addPayment(store.id, 60, 'cash', 'cash half'),
      service.addPayment(store.id, 40, 'promptpay', 'transfer remainder'),
    ]);

    const finalState = store.getState();
    expect(results).toHaveLength(2);
    expect(finalState.paidAmount).toBe(100);
    expect(finalState.depositTotal).toBe(100);
    expect(finalState.remainingTotal).toBe(0);
    expect(finalState.status).toBe('paid');
    expect(finalState.payments).toHaveLength(2);
    expect(finalState.payments.map((payment) => payment.amount).sort()).toEqual(
      [40, 60],
    );
    expect(finalState.statusHistory).toHaveLength(2);
  });

  it('preserves all five payment facts under a five-request race', async () => {
    const store = makeAtomicOrderModel({ concurrentReaders: 5 });
    const service = makeService(store.model);

    const results = await Promise.all([
      service.addPayment(store.id, 20, 'cash', 'payment 1'),
      service.addPayment(store.id, 20, 'promptpay', 'payment 2'),
      service.addPayment(store.id, 20, 'cash', 'payment 3'),
      service.addPayment(store.id, 20, 'promptpay', 'payment 4'),
      service.addPayment(store.id, 20, 'cash', 'payment 5'),
    ]);

    const finalState = store.getState();
    expect(results).toHaveLength(5);
    expect(finalState.paidAmount).toBe(100);
    expect(finalState.remainingTotal).toBe(0);
    expect(finalState.status).toBe('paid');
    expect(finalState.payments).toHaveLength(5);
    expect(finalState.payments.map((payment) => payment.amount)).toEqual([
      20, 20, 20, 20, 20,
    ]);
  });

  it('rejects the losing concurrent payment when both cannot fit the balance', async () => {
    const store = makeAtomicOrderModel({ concurrentReaders: 2 });
    const service = makeService(store.model);

    const results = await Promise.allSettled([
      service.addPayment(store.id, 60, 'cash'),
      service.addPayment(store.id, 60, 'promptpay'),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const finalState = store.getState();

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    expect(finalState.paidAmount).toBe(60);
    expect(finalState.remainingTotal).toBe(40);
    expect(finalState.status).toBe('partial');
    expect(finalState.payments).toHaveLength(1);
  });

  it('keeps satang exact while retrying after a concurrent state change', async () => {
    const store = makeAtomicOrderModel({ concurrentReaders: 2 });
    const service = makeService(store.model);

    await Promise.all([
      service.addPayment(store.id, 33.33, 'cash'),
      service.addPayment(store.id, 66.67, 'promptpay'),
    ]);

    const finalState = store.getState();
    expect(finalState.paidAmount).toBe(100);
    expect(finalState.remainingTotal).toBe(0);
    expect(finalState.payments.map((payment) => payment.amount).sort()).toEqual(
      [33.33, 66.67],
    );
  });

  it('derives the next balance from authoritative payment facts', async () => {
    const store = makeAtomicOrderModel({
      paidAmount: 30,
      remainingTotal: 70,
      payments: [
        {
          amount: 30,
          method: 'cash',
          paidAt: new Date('2026-08-27T00:00:00.000Z'),
        },
      ],
    });
    const service = makeService(store.model);

    await service.addPayment(store.id, 20, 'promptpay');

    const finalState = store.getState();
    expect(finalState.paidAmount).toBe(50);
    expect(finalState.depositTotal).toBe(50);
    expect(finalState.remainingTotal).toBe(50);
    expect(finalState.status).toBe('partial');
    expect(finalState.payments).toHaveLength(2);
  });

  it('blocks new money when scalar totals drift from payment facts', async () => {
    const store = makeAtomicOrderModel({
      paidAmount: 20,
      remainingTotal: 80,
      payments: [
        {
          amount: 30,
          method: 'cash',
          paidAt: new Date('2026-08-27T00:00:00.000Z'),
        },
      ],
    });
    const service = makeService(store.model);

    await expect(
      service.addPayment(store.id, 10, 'promptpay'),
    ).rejects.toBeInstanceOf(ConflictException);

    const finalState = store.getState();
    expect(finalState.paidAmount).toBe(20);
    expect(finalState.remainingTotal).toBe(80);
    expect(finalState.payments).toHaveLength(1);
  });

  it('replays the same idempotent payment without duplicating money', async () => {
    const store = makeAtomicOrderModel();
    const service = makeService(store.model);

    const first = await service.addPayment(
      store.id,
      40,
      'cash',
      'first receipt',
      'payment-key-001',
    );
    const replay = await service.addPayment(
      store.id,
      40,
      'cash',
      'first receipt',
      'payment-key-001',
    );

    const finalState = store.getState();
    expect(first.paidAmount).toBe(40);
    expect(replay.paidAmount).toBe(40);
    expect(finalState.paidAmount).toBe(40);
    expect(finalState.remainingTotal).toBe(60);
    expect(finalState.payments).toHaveLength(1);
    expect(finalState.payments[0]).toEqual(
      expect.objectContaining({
        amount: 40,
        method: 'cash',
        idempotencyKey: 'payment-key-001',
      }),
    );
  });

  it('deduplicates two concurrent requests with the same idempotency key', async () => {
    const store = makeAtomicOrderModel({ concurrentReaders: 2 });
    const service = makeService(store.model);

    const results = await Promise.all([
      service.addPayment(
        store.id,
        40,
        'promptpay',
        'same transfer',
        'payment-key-race',
      ),
      service.addPayment(
        store.id,
        40,
        'promptpay',
        'same transfer',
        'payment-key-race',
      ),
    ]);

    const finalState = store.getState();
    expect(results).toHaveLength(2);
    expect(results[0].paidAmount).toBe(40);
    expect(results[1].paidAmount).toBe(40);
    expect(finalState.paidAmount).toBe(40);
    expect(finalState.remainingTotal).toBe(60);
    expect(finalState.payments).toHaveLength(1);
  });

  it('rejects reusing an idempotency key for a different payment', async () => {
    const store = makeAtomicOrderModel();
    const service = makeService(store.model);

    await service.addPayment(
      store.id,
      40,
      'cash',
      'first receipt',
      'payment-key-conflict',
    );

    await expect(
      service.addPayment(
        store.id,
        41,
        'cash',
        'first receipt',
        'payment-key-conflict',
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const finalState = store.getState();
    expect(finalState.paidAmount).toBe(40);
    expect(finalState.payments).toHaveLength(1);
  });
});
