import {
  ValidationPipe,
  INestApplication,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersSseService } from '../src/orders/orders.sse.service';
import { AuditService } from '../src/auth/audit.service';
import { AuthService } from '../src/auth/auth.service';

describe('OrdersController (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  const updateOrder = jest.fn();
  const updateStatus = jest.fn();
  const create = jest.fn();
  const findAll = jest.fn();
  const findById = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        {
          provide: OrdersService,
          useValue: {
            create,
            findAll,
            getSummary: jest.fn(),
            findLatestActive: jest.fn(),
            updateStatus,
            findByOrderId: jest.fn(),
            findById,
            updateOrder,
            addPayment: jest.fn(),
          },
        },
        {
          provide: OrdersSseService,
          useValue: {
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
    updateOrder.mockReset();
    updateStatus.mockReset();
    create.mockReset();
    findAll.mockReset();
    findById.mockReset();
  });

  it('POST /orders accepts the current POS rich order payload', async () => {
    create.mockResolvedValue({
      _id: '61a1c287e53a7024d4ab81425',
      orderId: '61a1c287e53a7024d4ab81425',
      orderNumber: 'GL-20260604-0001',
      customerName: 'Glossy Customer',
      phoneNumber: '0812345678',
      note: 'rush',
      total: 1000,
      subtotal: 1000,
      discount: 0,
      depositTotal: 500,
      paidAmount: 500,
      remainingTotal: 570,
      payment: 'promptpay',
      paymentMethod: 'promptpay',
      status: 'partial',
      taxInvoice: 'yes',
      vatAmount: 70,
      grandTotal: 1070,
      payments: [],
      statusHistory: [],
      cart: [],
    });

    await request(server)
      .post('/orders')
      .send({
        clientDraftId: 'draft-123',
        customerName: 'Glossy Customer',
        companyName: 'Glossy Co',
        phoneNumber: '0812345678',
        email: 'customer@example.com',
        address: '88/8 Test Road',
        taxId: '0123456789012',
        branch: 'HQ',
        salesChannel: 'pos',
        payment: 'promptpay',
        status: 'partial',
        total: 1000,
        discount: 0,
        depositTotal: 500,
        remainingTotal: 570,
        taxInvoice: 'yes',
        vatAmount: 70,
        grandTotal: 1070,
        cart: [
          {
            key: 'line-1',
            name: 'Sticker PP',
            category: 'Sticker',
            variant: {
              id: 'variant-a4',
              name: 'A4',
              price: 100,
              custom: true,
              width: 210,
              height: 297,
            },
            qty: 10,
            unitPrice: 100,
            totalPrice: 1000,
            lineTotal: 1000,
            productNote: 'Matte finish',
            colorMode: 'color',
            type: 'normal',
            shape: 'circle',
            setCount: 2,
            sizeFlex: [{ width: '210', height: '297' }],
            material: 'pp',
            sides: '1',
            stickerPVCType: 'clear',
            plotPlanType: 'a1',
            typePremium: 'roundpin',
            deposit: 500,
            remaining: 500,
            fullPayment: false,
          },
        ],
      })
      .expect(201);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taxInvoice: 'yes',
        vatAmount: 70,
        companyName: 'Glossy Co',
        cart: [
          expect.objectContaining({
            lineTotal: 1000,
            plotPlanType: 'a1',
          }),
        ],
      }),
      undefined,
    );
  });

  it('POST /orders keeps validation strict for unknown rich payload fields', async () => {
    await request(server)
      .post('/orders')
      .send({
        customerName: 'Glossy Customer',
        cart: [
          {
            name: 'Sticker PP',
            qty: 1,
            unitPrice: 100,
            totalPrice: 100,
            unsupportedMetadata: true,
          },
        ],
      })
      .expect(400)
      .expect(({ body }: { body: { message: string | string[] } }) => {
        expect(body.message).toEqual(
          expect.arrayContaining([
            'cart.0.property unsupportedMetadata should not exist',
          ]),
        );
      });

    expect(create).not.toHaveBeenCalled();
  });

  it('PATCH /orders/:id updates customer info and returns the updated order', async () => {
    updateOrder.mockResolvedValue({
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

    expect(updateOrder).toHaveBeenCalledWith('61a1c287e53a7024d4ab81425', {
      customerName: 'Sarayut 111',
      phoneNumber: '0812345678',
      taxId: '0123456789012',
      customerTaxId: '0123456789012',
      address: '88/8 Moo Baan Klang Muang',
      customerAddress: '88/8 Moo Baan Klang Muang',
    });
  });

  it('PATCH /orders/:id returns 404 when order is missing', async () => {
    updateOrder.mockRejectedValue(
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

    expect(updateOrder).not.toHaveBeenCalled();
  });

  it('PATCH /orders/:id/status accepts workflow statuses', async () => {
    updateStatus.mockResolvedValue({
      _id: '61a1c287e53a7024d4ab81425',
      orderId: '61a1c287e53a7024d4ab81425',
      status: 'producing',
    });

    await request(server)
      .patch('/orders/61a1c287e53a7024d4ab81425/status')
      .send({ status: 'producing' })
      .expect(200)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body.status).toBe('producing');
      });

    expect(updateStatus).toHaveBeenCalledWith(
      '61a1c287e53a7024d4ab81425',
      'producing',
      undefined,
    );
  });

  it('PATCH /orders/:id accepts status updates', async () => {
    updateOrder.mockResolvedValue({
      _id: '61a1c287e53a7024d4ab81425',
      orderId: '61a1c287e53a7024d4ab81425',
      status: 'ready_for_pickup',
    });

    await request(server)
      .patch('/orders/61a1c287e53a7024d4ab81425')
      .send({ status: 'ready_for_pickup' })
      .expect(200)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body.status).toBe('ready_for_pickup');
      });

    expect(updateOrder).toHaveBeenCalledWith('61a1c287e53a7024d4ab81425', {
      status: 'ready_for_pickup',
    });
  });

  it('GET /orders returns a bounded paginated list', async () => {
    findAll.mockResolvedValue({
      data: [
        {
          _id: '61a1c287e53a7024d4ab81425',
          orderId: '61a1c287e53a7024d4ab81425',
          orderNumber: 'GL-20260604-0001',
          status: 'pending',
        },
      ],
      page: 2,
      limit: 5,
      total: 12,
    });

    await request(server)
      .get('/orders')
      .query({ page: '2', limit: '5' })
      .expect(200)
      .expect(
        ({
          body,
        }: {
          body: {
            data: Array<Record<string, unknown>>;
            page: number;
            limit: number;
            total: number;
          };
        }) => {
          expect(body.data[0].orderNumber).toBe('GL-20260604-0001');
          expect(body.page).toBe(2);
          expect(body.limit).toBe(5);
          expect(body.total).toBe(12);
        },
      );

    expect(findAll).toHaveBeenCalledWith({ page: 2, limit: 5 });
  });

  it('GET /orders rejects excessive list limits', async () => {
    await request(server)
      .get('/orders')
      .query({ limit: '500' })
      .expect(400)
      .expect(({ body }: { body: { message: string | string[] } }) => {
        expect(body.message).toEqual(
          expect.arrayContaining(['limit must not be greater than 100']),
        );
      });

    expect(findAll).not.toHaveBeenCalled();
  });

  it('GET /orders rejects legacy tracking q fallback', async () => {
    await request(server)
      .get('/orders')
      .query({ q: 'GL-20260604-0001' })
      .expect(400)
      .expect(({ body }: { body: { message: string | string[] } }) => {
        expect(body.message).toEqual(
          expect.arrayContaining(['property q should not exist']),
        );
      });

    expect(findAll).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it('GET /orders/track no longer performs tracking search', async () => {
    findById.mockRejectedValue(new BadRequestException('Invalid order id.'));

    await request(server)
      .get('/orders/track')
      .query({ q: 'GL-20260604-0001' })
      .expect(400)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toBe('Invalid order id.');
      });

    expect(findById).toHaveBeenCalledWith('track');
  });
});
