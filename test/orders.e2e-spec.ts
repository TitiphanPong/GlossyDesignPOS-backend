import {
  ValidationPipe,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersSseService } from '../src/orders/orders.sse.service';

describe('OrdersController (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  const updateCustomerInfo = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        {
          provide: OrdersService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            getSummary: jest.fn(),
            findLatestActive: jest.fn(),
            updateStatus: jest.fn(),
            findByOrderId: jest.fn(),
            findById: jest.fn(),
            updateCustomerInfo,
            addPayment: jest.fn(),
          },
        },
        {
          provide: OrdersSseService,
          useValue: {
            asObservable: jest.fn(),
          },
        },
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
    updateCustomerInfo.mockReset();
  });

  it('PATCH /orders/:id updates customer info and returns the updated order', async () => {
    updateCustomerInfo.mockResolvedValue({
      _id: '61a1c287e53a7024d4ab81425',
      orderId: '61a1c287e53a7024d4ab81425',
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
      cart: [],
      taxId: '0123456789012',
      customerTaxId: '0123456789012',
      address: '88/8 Moo Baan Klang Muang',
      customerAddress: '88/8 Moo Baan Klang Muang',
    });

    await request(server)
      .patch('/orders/61a1c287e53a7024d4ab81425')
      .send({
        customerName: 'Sarayut 111',
        phoneNumber: '0812345678',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
      })
      .expect(200)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body.customerName).toBe('Sarayut 111');
        expect(body.taxId).toBe('0123456789012');
        expect(body.customerTaxId).toBe('0123456789012');
        expect(body.address).toBe('88/8 Moo Baan Klang Muang');
        expect(body.customerAddress).toBe('88/8 Moo Baan Klang Muang');
      });

    expect(updateCustomerInfo).toHaveBeenCalledWith(
      '61a1c287e53a7024d4ab81425',
      {
        customerName: 'Sarayut 111',
        phoneNumber: '0812345678',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
      },
    );
  });

  it('PATCH /orders/:id returns 404 when order is missing', async () => {
    updateCustomerInfo.mockRejectedValue(
      new NotFoundException('Order not found for id "missing-order".'),
    );

    await request(server)
      .patch('/orders/missing-order')
      .send({ customerName: 'Missing Customer' })
      .expect(404)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toContain('Order not found');
      });
  });

  it('PATCH /orders/:id rejects invalid payloads with 400', async () => {
    await request(server)
      .patch('/orders/61a1c287e53a7024d4ab81425')
      .send({ total: 9999 })
      .expect(400)
      .expect(({ body }: { body: { message: string | string[] } }) => {
        expect(body.message).toEqual(
          expect.arrayContaining(['property total should not exist']),
        );
      });

    expect(updateCustomerInfo).not.toHaveBeenCalled();
  });
});
