import { BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Connection, Model, createConnection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
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

function makeService(orderModel: Model<OrderDocument>): OrdersService {
  const ordersSse = {
    emitOrder: jest.fn(),
    emitOrderAndAutoClear: jest.fn(),
  } as unknown as OrdersSseService;
  const notificationsService = {
    autoResolvePaymentNotifications: jest.fn().mockResolvedValue(undefined),
    handleOrderPaymentState: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;

  return new OrdersService(
    orderModel,
    {} as RunningNumberService,
    ordersSse,
    {} as OrderPricingService,
    undefined as unknown as OrderReportingService,
    notificationsService,
  );
}

describeMongo('OrdersService addPayment against isolated MongoDB', () => {
  let mongo: MongoMemoryServer;
  let connection: Connection;
  let orderModel: Model<OrderDocument>;
  let service: OrdersService;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    connection = createConnection(mongo.getUri(), {
      dbName: 'glossy-payment-integrity',
    });
    await connection.asPromise();
    orderModel = connection.model(
      Order.name,
      OrderSchema,
    ) as unknown as Model<OrderDocument>;
    service = makeService(orderModel);
  });

  afterAll(async () => {
    await connection?.close();
    await mongo?.stop();
  });

  beforeEach(async () => {
    await orderModel.deleteMany({});
  });

  async function createUnpaidOrder(grandTotal = 100): Promise<string> {
    const order = await orderModel.create({
      orderType: 'NORMAL',
      orderId: randomUUID(),
      orderNumber: `MONGO-${randomUUID()}`,
      customerName: 'Concurrent customer',
      phoneNumber: '0812345678',
      note: '',
      total: grandTotal,
      subtotal: grandTotal,
      discount: 0,
      depositTotal: 0,
      paidAmount: 0,
      remainingTotal: grandTotal,
      payment: 'cash',
      paymentMethod: 'cash',
      status: 'awaiting_payment',
      taxInvoice: 'no',
      vatAmount: 0,
      grandTotal,
      payments: [],
      statusHistory: [],
      cart: [],
    });

    return order._id.toString();
  }

  it('persists all five payment facts during a real five-request race', async () => {
    const orderId = await createUnpaidOrder();

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.addPayment(
          orderId,
          20,
          index % 2 === 0 ? 'cash' : 'promptpay',
          `payment ${index + 1}`,
          `mongo-race-${index + 1}`,
        ),
      ),
    );

    const stored = await orderModel.findById(orderId).lean().exec();
    expect(results).toHaveLength(5);
    expect(stored?.payments).toHaveLength(5);
    expect(stored?.paidAmount).toBe(100);
    expect(stored?.depositTotal).toBe(100);
    expect(stored?.remainingTotal).toBe(0);
    expect(stored?.status).toBe('paid');
    expect(
      stored?.payments.map((payment) => payment.idempotencyKey).sort(),
    ).toEqual([
      'mongo-race-1',
      'mongo-race-2',
      'mongo-race-3',
      'mongo-race-4',
      'mongo-race-5',
    ]);
  });

  it('accepts only one of two concurrent payments that cannot both fit', async () => {
    const orderId = await createUnpaidOrder();

    const results = await Promise.allSettled([
      service.addPayment(orderId, 60, 'cash', undefined, 'mongo-overpay-1'),
      service.addPayment(
        orderId,
        60,
        'promptpay',
        undefined,
        'mongo-overpay-2',
      ),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    const stored = await orderModel.findById(orderId).lean().exec();

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    expect(stored?.payments).toHaveLength(1);
    expect(stored?.paidAmount).toBe(60);
    expect(stored?.remainingTotal).toBe(40);
    expect(stored?.status).toBe('partial');
  });

  it('deduplicates concurrent retries that use the same payment idempotency key', async () => {
    const orderId = await createUnpaidOrder();

    const results = await Promise.all([
      service.addPayment(orderId, 50, 'cash', 'same payment', 'mongo-retry-1'),
      service.addPayment(orderId, 50, 'cash', 'same payment', 'mongo-retry-1'),
    ]);

    const stored = await orderModel.findById(orderId).lean().exec();
    expect(results).toHaveLength(2);
    expect(stored?.payments).toHaveLength(1);
    expect(stored?.payments[0]?.idempotencyKey).toBe('mongo-retry-1');
    expect(stored?.paidAmount).toBe(50);
    expect(stored?.remainingTotal).toBe(50);
    expect(stored?.status).toBe('partial');
  });

  it('preserves satang through concurrent real-Mongo updates', async () => {
    const orderId = await createUnpaidOrder();

    await Promise.all([
      service.addPayment(orderId, 33.33, 'cash', undefined, 'mongo-satang-1'),
      service.addPayment(
        orderId,
        66.67,
        'promptpay',
        undefined,
        'mongo-satang-2',
      ),
    ]);

    const stored = await orderModel.findById(orderId).lean().exec();
    expect(stored?.payments).toHaveLength(2);
    expect(stored?.paidAmount).toBe(100);
    expect(stored?.remainingTotal).toBe(0);
    expect(stored?.status).toBe('paid');
  });
});
