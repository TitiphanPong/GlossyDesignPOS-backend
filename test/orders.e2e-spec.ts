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
  const exportOrders = jest.fn();
  const recordAudit = jest.fn();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        {
          provide: OrdersService,
          useValue: {
            create,
            findAll,
            exportOrders,
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
        { provide: AuditService, useValue: { record: recordAudit } },
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
    exportOrders.mockReset();
    recordAudit.mockReset();
  });

  it('GET /orders/export returns a real PDF response and forwards filters', async () => {
    exportOrders.mockResolvedValue({
      buffer: Buffer.from('%PDF-test'),
      contentType: 'application/pdf',
      filename: 'orders-2026-08.pdf',
      count: 12,
    });

    await request(server)
      .get('/orders/export?format=pdf&saleMonth=2026-08&sort=amount_desc')
      .expect(200)
      .expect('Content-Type', /application\/pdf/)
      .expect(
        'Content-Disposition',
        'attachment; filename="orders-2026-08.pdf"',
      );

    expect(exportOrders).toHaveBeenCalledWith(
      expect.objectContaining({
        format: 'pdf',
        saleMonth: '2026-08',
        sort: 'amount_desc',
      }),
    );
    expect(recordAudit).toHaveBeenCalledWith(
      null,
      'order.report.export',
      { type: 'order_report', id: '2026-08' },
      { format: 'pdf', count: 12, saleMonth: '2026-08' },
    );
  });

  it('GET /orders/export rejects an invalid sale month before generation', async () => {
    await request(server)
      .get('/orders/export?format=xlsx&saleMonth=2026-13')
      .expect(400);
    expect(exportOrders).not.toHaveBeenCalled();
  });

  it('POST /orders accepts only pricing intents and payment facts', async () => {
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
        discount: { type: 'amount', value: 0 },
        initialPayment: { amount: 500, method: 'promptpay' },
        taxInvoice: 'yes',
        cart: [
          {
            productId: '61a1c287e53a7024d4ab8142',
            variantId: 'variant-a4',
            quantity: 10,
            priceOverride: {
              unitPrice: 100,
              reason: 'approved configured quote',
            },
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
            fullPayment: false,
          },
        ],
      })
      .expect(201);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        taxInvoice: 'yes',
        companyName: 'Glossy Co',
        cart: [
          expect.objectContaining({
            quantity: 10,
            priceOverride: {
              unitPrice: 100,
              reason: 'approved configured quote',
            },
            plotPlanType: 'a1',
          }),
        ],
      }),
      undefined,
      undefined,
    );
  });

  it('POST /orders rejects caller-authored totals and financial status', async () => {
    await request(server)
      .post('/orders')
      .send({
        customerName: 'Tampered',
        subtotal: 1,
        grandTotal: 1,
        paidAmount: 1,
        remainingTotal: 0,
        status: 'paid',
        cart: [
          {
            customName: 'Custom item',
            quantity: 1,
            priceOverride: { unitPrice: 100, reason: 'approved quote' },
            unitPrice: 1,
            lineTotal: 1,
          },
        ],
      })
      .expect(400)
      .expect(({ body }: { body: { message: string[] } }) => {
        expect(body.message).toEqual(
          expect.arrayContaining([
            'property subtotal should not exist',
            'property grandTotal should not exist',
            'property paidAmount should not exist',
            'property remainingTotal should not exist',
            'property status should not exist',
            'cart.0.property unitPrice should not exist',
            'cart.0.property lineTotal should not exist',
          ]),
        );
      });

    expect(create).not.toHaveBeenCalled();
  });

  it('POST /orders keeps validation strict for unknown rich payload fields', async () => {
    await request(server)
      .post('/orders')
      .send({
        customerName: 'Glossy Customer',
        cart: [
          {
            customName: 'Sticker PP',
            quantity: 1,
            priceOverride: { unitPrice: 100, reason: 'approved quote' },
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

  it.each([
    {
      quantity: 0,
      unitPrice: 100,
      expected: 'cart.0.quantity must not be less than 1',
    },
    {
      quantity: -1,
      unitPrice: 100,
      expected: 'cart.0.quantity must not be less than 1',
    },
    {
      quantity: 1,
      unitPrice: 0,
      expected: 'cart.0.priceOverride.unitPrice must not be less than 0.01',
    },
    {
      quantity: 1,
      unitPrice: -1,
      expected: 'cart.0.priceOverride.unitPrice must not be less than 0.01',
    },
  ])(
    'POST /orders rejects invalid quantity/price facts: %p',
    async ({ quantity, unitPrice, expected }) => {
      await request(server)
        .post('/orders')
        .send({
          cart: [
            {
              customName: 'Invalid item',
              quantity,
              priceOverride: { unitPrice, reason: 'test' },
            },
          ],
        })
        .expect(400)
        .expect(({ body }: { body: { message: string[] } }) => {
          expect(body.message).toEqual(expect.arrayContaining([expected]));
        });
    },
  );

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

    expect(updateOrder).toHaveBeenCalledWith(
      '61a1c287e53a7024d4ab81425',
      {
        customerName: 'Sarayut 111',
        phoneNumber: '0812345678',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
      },
      undefined,
    );
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

    expect(updateOrder).toHaveBeenCalledWith(
      '61a1c287e53a7024d4ab81425',
      {
        status: 'ready_for_pickup',
      },
      undefined,
    );
  });

  it('DELETE /orders/:id is not available for production hard delete', async () => {
    await request(server)
      .delete('/orders/61a1c287e53a7024d4ab81425')
      .send({ password: 'irrelevant' })
      .expect(404);
  });

  it('POST /orders/:id/cancel requires a cancellation reason', async () => {
    await request(server)
      .post('/orders/61a1c287e53a7024d4ab81425/cancel')
      .send({ reason: '' })
      .expect(400)
      .expect(({ body }: { body: { message: string | string[] } }) => {
        expect(body.message).toEqual(
          expect.arrayContaining([
            'reason must be longer than or equal to 1 characters',
          ]),
        );
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
