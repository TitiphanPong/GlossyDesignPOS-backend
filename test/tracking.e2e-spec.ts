import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OrdersService } from '../src/orders/orders.service';
import { TrackingController } from '../src/tracking/tracking.controller';
import {
  THROTTLER_LIMIT,
  THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';

describe('Public tracking privacy contract (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const lookupPublicTracking = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [TrackingController],
      providers: [
        {
          provide: OrdersService,
          useValue: { lookupPublicTracking },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => app.close());

  beforeEach(() => lookupPublicTracking.mockReset());

  it('applies the strict public lookup rate-limit policy', () => {
    const handler = Object.getOwnPropertyDescriptor(
      TrackingController.prototype,
      'lookup',
    )?.value as object;
    expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, handler)).toBe(10);
    expect(Reflect.getMetadata(`${THROTTLER_TTL}default`, handler)).toBe(
      60_000,
    );
  });

  it('requires an exact order number and four phone digits', async () => {
    await request(server)
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD', phoneSuffix: '12' })
      .expect(400);
    await request(server)
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD-000123', phoneSuffix: '12ab' })
      .expect(400);
    expect(lookupPublicTracking).not.toHaveBeenCalled();
  });

  it('returns only the minimal public status contract', async () => {
    lookupPublicTracking.mockResolvedValue({
      orderNumber: 'GD-000123',
      status: 'producing',
      createdAt: new Date('2026-08-12T01:00:00.000Z'),
      updatedAt: new Date('2026-08-12T02:00:00.000Z'),
    });

    const response = await request(server)
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD-000123', phoneSuffix: '5678' })
      .expect(201);

    expect(response.body).toEqual({
      orderNumber: 'GD-000123',
      status: 'producing',
      createdAt: '2026-08-12T01:00:00.000Z',
      updatedAt: '2026-08-12T02:00:00.000Z',
    });
    expect(response.body).not.toHaveProperty('customerName');
    expect(response.body).not.toHaveProperty('phoneNumber');
    expect(response.body).not.toHaveProperty('cart');
    expect(response.body).not.toHaveProperty('grandTotal');
  });

  it('uses the same not-found response for a missing order or verifier mismatch', async () => {
    lookupPublicTracking.mockResolvedValue(null);
    await request(server)
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD-000123', phoneSuffix: '0000' })
      .expect(404)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toBe('Order not found');
      });
  });
});
