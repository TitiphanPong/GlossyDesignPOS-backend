import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { HealthController } from '../src/health.controller';
import { HealthService } from '../src/health.service';

describe('Health readiness detail (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    const details = {
      status: 'ready' as const,
      checkedAt: '2026-08-29T09:00:00.000Z',
      dependencies: {
        database: 'ready' as const,
        objectStorage: 'ready' as const,
      },
    };
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: HealthService,
          useValue: {
            isReady: jest.fn().mockResolvedValue(true),
            getReadinessDetails: jest.fn().mockResolvedValue(details),
          },
        },
        {
          provide: AuthService,
          useValue: {
            authenticate: jest.fn((token: string) =>
              Promise.resolve(
                token === 'staff-token'
                  ? { id: '1', username: 'staff', role: 'staff' }
                  : null,
              ),
            ),
          },
        },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => app.close());

  it('keeps public liveness/readiness minimal while protecting dependency detail', async () => {
    await request(server).get('/health').expect(200, { status: 'ok' });
    await request(server).get('/health/ready').expect(200, { status: 'ready' });
    await request(server).get('/health/ready/details').expect(401);
  });

  it('returns bounded readiness detail to authenticated staff', async () => {
    const response = await request(server)
      .get('/health/ready/details')
      .set('Authorization', 'Bearer staff-token')
      .expect(200);

    expect(response.body).toEqual({
      status: 'ready',
      checkedAt: '2026-08-29T09:00:00.000Z',
      dependencies: {
        database: 'ready',
        objectStorage: 'ready',
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /mongodb_uri|access[_-]?key|secret|bucket|token|credential/i,
    );
  });
});
