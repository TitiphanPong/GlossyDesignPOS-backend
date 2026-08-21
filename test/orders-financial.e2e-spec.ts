import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AuditService } from '../src/auth/audit.service';
import { AuthService } from '../src/auth/auth.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { RunningNumberService } from '../src/counters/running-number.service';
import { OrdersController } from '../src/orders/orders.controller';
import { OrderPricingService } from '../src/orders/order-pricing.service';
import { Order } from '../src/orders/orders.schema';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersSseService } from '../src/orders/orders.sse.service';
import { Product } from '../src/products/product.schema';
import { QuickProduct } from '../src/quick-products/quick-product.schema';

describe('authoritative order financial pipeline (integration)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const saved: Array<Record<string, unknown>> = [];

  class FakeOrderModel {
    static findOne = jest
      .fn()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) });
    _id = { toString: () => '61a1c287e53a7024d4ab8199' };
    orderId?: string;

    constructor(payload: Record<string, unknown>) {
      Object.assign(this, payload);
    }

    save() {
      saved.push(this.toObject());
      return Promise.resolve(this);
    }

    toObject(): Record<string, unknown> {
      return { ...this, _id: this._id } as Record<string, unknown>;
    }
  }

  beforeAll(async () => {
    const catalogProduct = {
      _id: { toString: () => '61a1c287e53a7024d4ab8142' },
      name: 'A4 Print',
      code: 'A4',
      typeCode: 'a4-print',
      category: 'Document',
      active: true,
      variants: [
        {
          _id: { toString: () => '61a1c287e53a7024d4ab8143' },
          name: 'Default',
          price: 100,
          active: true,
        },
      ],
    };
    const catalogModel = {
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(catalogProduct),
      }),
    };
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        OrdersService,
        OrderPricingService,
        { provide: getModelToken(Order.name), useValue: FakeOrderModel },
        { provide: getModelToken(Product.name), useValue: catalogModel },
        { provide: getModelToken(QuickProduct.name), useValue: catalogModel },
        {
          provide: RunningNumberService,
          useValue: {
            generateOrderNumber: jest
              .fn()
              .mockResolvedValue('GL-20260821-0001'),
            generateTaxInvoiceNumber: jest
              .fn()
              .mockResolvedValue('INV-20260821-0001'),
          },
        },
        {
          provide: OrdersSseService,
          useValue: {
            emitOrder: jest.fn(),
            emitOrderAndAutoClear: jest.fn(),
            asObservable: jest.fn(),
          },
        },
        { provide: AuditService, useValue: { record: jest.fn() } },
        { provide: AuthService, useValue: { confirmPassword: jest.fn() } },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    saved.length = 0;
  });

  it('does not add VAT to a regular receipt', async () => {
    await request(server)
      .post('/orders')
      .send({
        orderType: 'QUICK_SALE',
        cart: [{ productCode: 'A4', quantity: 1 }],
        discount: { type: 'amount', value: 10 },
        initialPayment: {
          amount: 90,
          method: 'cash',
          receivedAmount: 100,
        },
        taxInvoice: 'no',
      })
      .expect(201)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toEqual(
          expect.objectContaining({
            subtotal: 100,
            discount: 10,
            vatAmount: 0,
            grandTotal: 90,
            paidAmount: 90,
            remainingTotal: 0,
            receivedAmount: 100,
            changeAmount: 10,
            status: 'paid',
          }),
        );
      });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(
      expect.objectContaining({
        total: 100,
        grandTotal: 90,
        status: 'paid',
      }),
    );
  });

  it('adds VAT 7% to a tax invoice', async () => {
    await request(server)
      .post('/orders')
      .send({
        orderType: 'QUICK_SALE',
        cart: [{ productCode: 'A4', quantity: 1 }],
        discount: { type: 'amount', value: 10 },
        initialPayment: {
          amount: 96.3,
          method: 'cash',
          receivedAmount: 100,
        },
        taxInvoice: 'yes',
      })
      .expect(201)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toEqual(
          expect.objectContaining({
            subtotal: 100,
            discount: 10,
            vatAmount: 6.3,
            grandTotal: 96.3,
            paidAmount: 96.3,
            remainingTotal: 0,
            changeAmount: 3.7,
            status: 'paid',
          }),
        );
      });
  });

  it('keeps percentage and satang rounding authoritative through the HTTP contract', async () => {
    await request(server)
      .post('/orders')
      .send({
        orderType: 'QUICK_SALE',
        cart: [{ productCode: 'A4', quantity: 3 }],
        discount: { type: 'percent', value: 12.345 },
        taxInvoice: 'yes',
      })
      .expect(201)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toEqual(
          expect.objectContaining({
            subtotal: 300,
            discount: 37.05,
            vatAmount: 18.41,
            grandTotal: 281.36,
            paidAmount: 0,
            remainingTotal: 281.36,
            status: 'awaiting_payment',
          }),
        );
      });
  });
});
