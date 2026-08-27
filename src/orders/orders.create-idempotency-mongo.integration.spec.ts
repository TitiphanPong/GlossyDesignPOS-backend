import { ConflictException } from '@nestjs/common';
import { Connection, Model, createConnection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AuthenticatedUser } from '../auth/auth.types';
import { RunningNumberService } from '../counters/running-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateOrderDto } from './dto/order.dto';
import { OrderPricingService } from './order-pricing.service';
import { OrderReportingService } from './order-reporting.service';
import { Order, OrderDocument, OrderSchema } from './orders.schema';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';

jest.setTimeout(120_000);

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === '1' ? describe : describe.skip;

describeMongo(
  'OrdersService create idempotency binding against MongoDB',
  () => {
    let mongo: MongoMemoryServer;
    let connection: Connection;
    let orderModel: Model<OrderDocument>;
    let service: OrdersService;
    let sequence: number;

    const actorA: AuthenticatedUser = {
      id: '61a1c287e53a7024d4ab8101',
      username: 'cashier-a',
      role: 'admin',
    };
    const actorB: AuthenticatedUser = {
      id: '61a1c287e53a7024d4ab8102',
      username: 'cashier-b',
      role: 'admin',
    };

    beforeAll(async () => {
      mongo = await MongoMemoryServer.create();
      connection = createConnection(mongo.getUri(), {
        dbName: 'glossy-create-idempotency',
      });
      await connection.asPromise();
      orderModel = connection.model(
        Order.name,
        OrderSchema,
      ) as unknown as Model<OrderDocument>;
      await orderModel.init();

      const runningNumberService = {
        generateOrderNumber: jest.fn(() => {
          sequence += 1;
          return Promise.resolve(
            `GD-2026-${sequence.toString().padStart(6, '0')}`,
          );
        }),
      } as unknown as RunningNumberService;
      const orderPricing = {
        resolveCart: jest.fn((_orderType, cart: CreateOrderDto['cart'] = []) =>
          Promise.resolve(
            cart.map((item) => ({
              name: item.customName ?? item.productCode ?? 'Item',
              qty: item.quantity,
              unitPrice: item.priceOverride?.unitPrice ?? 100,
              totalPrice:
                item.quantity * (item.priceOverride?.unitPrice ?? 100),
              lineTotal: item.quantity * (item.priceOverride?.unitPrice ?? 100),
            })),
          ),
        ),
      } as unknown as OrderPricingService;
      const ordersSse = {
        emitOrder: jest.fn(),
        emitOrderAndAutoClear: jest.fn(),
      } as unknown as OrdersSseService;
      const notificationsService = {
        createNotification: jest.fn().mockResolvedValue(undefined),
        autoResolvePaymentNotifications: jest.fn().mockResolvedValue(undefined),
        handleOrderPaymentState: jest.fn().mockResolvedValue(undefined),
        handleOrderStatusChange: jest.fn().mockResolvedValue(undefined),
      } as unknown as NotificationsService;

      service = new OrdersService(
        orderModel,
        runningNumberService,
        ordersSse,
        orderPricing,
        undefined as unknown as OrderReportingService,
        notificationsService,
        connection,
      );
    });

    afterAll(async () => {
      await connection?.close();
      await mongo?.stop();
    });

    beforeEach(async () => {
      sequence = 0;
      await orderModel.deleteMany({});
    });

    function command(overrides: Partial<CreateOrderDto> = {}): CreateOrderDto {
      return {
        customerName: 'Idempotent customer',
        phoneNumber: '0812345678',
        note: 'same command',
        cart: [
          {
            customName: 'A4 Print',
            quantity: 1,
            priceOverride: { unitPrice: 100, reason: 'test command' },
          },
        ],
        ...overrides,
      };
    }

    it('replays the original result for the same actor and canonical command', async () => {
      const first = await service.create(command(), 'create-key-1', actorA);
      const replay = await service.create(
        {
          cart: command().cart,
          note: 'same command',
          phoneNumber: '0812345678',
          customerName: 'Idempotent customer',
        },
        'create-key-1',
        actorA,
      );

      expect(replay._id).toBe(first._id);
      expect(await orderModel.countDocuments()).toBe(1);
      const stored = await orderModel.findById(first._id).lean().exec();
      expect(stored?.createCommandFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    });

    it('rejects the same idempotency identity with a different payload', async () => {
      await service.create(command(), 'create-key-2', actorA);

      await expect(
        service.create(
          command({ customerName: 'Different customer' }),
          'create-key-2',
          actorA,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(await orderModel.countDocuments()).toBe(1);
    });

    it('rejects the same idempotency identity when a different actor reuses it', async () => {
      await service.create(command(), 'create-key-3', actorA);

      await expect(
        service.create(command(), 'create-key-3', actorB),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(await orderModel.countDocuments()).toBe(1);
    });

    it('deduplicates concurrent retries of the same actor and command', async () => {
      const [left, right] = await Promise.all([
        service.create(command(), 'create-key-4', actorA),
        service.create(command(), 'create-key-4', actorA),
      ]);

      expect(left._id).toBe(right._id);
      expect(await orderModel.countDocuments()).toBe(1);
    });

    it('fails closed for a legacy idempotency record without a command fingerprint', async () => {
      await orderModel.create({
        orderId: 'legacy-idempotency-order',
        orderNumber: 'GD-2026-999999',
        clientDraftId: 'create-key-legacy',
        idempotencyKey: 'create-key-legacy',
        customerName: 'Legacy customer',
        phoneNumber: '0812345678',
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
      });

      await expect(
        service.create(command(), 'create-key-legacy', actorA),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  },
);
