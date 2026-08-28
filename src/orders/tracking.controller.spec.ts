import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OrdersService } from './orders.service';
import { TrackingController } from './tracking.controller';

describe('TrackingController', () => {
  let app: INestApplication;
  const lookupPublicTracking = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TrackingController],
      providers: [
        {
          provide: OrdersService,
          useValue: { lookupPublicTracking },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lookupPublicTracking.mockReset();
  });

  it('returns the customer-safe tracking milestone response', async () => {
    lookupPublicTracking.mockResolvedValue({
      orderNumber: 'GD-2026-000001',
      currentMilestone: 'ready',
      milestones: [
        {
          milestone: 'received',
          reachedAt: new Date('2026-08-27T00:00:00.000Z'),
        },
        {
          milestone: 'ready',
          reachedAt: new Date('2026-08-27T01:00:00.000Z'),
        },
      ],
      updatedAt: new Date('2026-08-27T01:00:00.000Z'),
    });

    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD-2026-000001', phoneSuffix: '5678' })
      .expect(201)
      .expect(({ body }: { body: Record<string, unknown> }) => {
        expect(body).toEqual(
          expect.objectContaining({
            orderNumber: 'GD-2026-000001',
            currentMilestone: 'ready',
            milestones: [
              expect.objectContaining({ milestone: 'received' }),
              expect.objectContaining({ milestone: 'ready' }),
            ],
          }),
        );
        expect(body).not.toHaveProperty('status');
        expect(body).not.toHaveProperty('customerName');
        expect(body).not.toHaveProperty('phoneNumber');
        expect(body).not.toHaveProperty('cart');
        expect(body).not.toHaveProperty('grandTotal');
      });

    expect(lookupPublicTracking).toHaveBeenCalledWith('GD-2026-000001', '5678');
  });

  it('rejects malformed phone suffixes before service lookup', async () => {
    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD-2026-000001', phoneSuffix: '678' })
      .expect(400);

    expect(lookupPublicTracking).not.toHaveBeenCalled();
  });

  it('uses the same not-found response when the combined verifier does not match', async () => {
    lookupPublicTracking.mockResolvedValue(null);

    await request(app.getHttpServer() as Parameters<typeof request>[0])
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD-2026-000001', phoneSuffix: '9999' })
      .expect(404);
  });
});
