import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { AuditService } from '../src/auth/audit.service';
import { HealthController } from '../src/health.controller';
import { OrdersController } from '../src/orders/orders.controller';
import { OrdersService } from '../src/orders/orders.service';
import { OrdersSseService } from '../src/orders/orders.sse.service';
import { ProductController } from '../src/products/product.controller';
import { ProductService } from '../src/products/product.service';
import { QuickProductController } from '../src/quick-products/quick-product.controller';
import { QuickProductService } from '../src/quick-products/quick-product.service';
import { UploadsController } from '../src/uploads/uploads.controller';
import { UploadsService } from '../src/uploads/uploads.service';
import { TrackingController } from '../src/tracking/tracking.controller';

type Role = 'staff' | 'manager' | 'admin';

const bearer = (role: Role) => ({ Authorization: `Bearer ${role}-token` });

describe('Production controller authorization matrix (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    const authService = {
      authenticate: jest.fn((token: string) => {
        const role = token.replace('-token', '') as Role;
        if (!['staff', 'manager', 'admin'].includes(role)) {
          return Promise.resolve(null);
        }
        return Promise.resolve({ id: `${role}-id`, username: role, role });
      }),
      login: jest.fn(() => Promise.resolve({ accessToken: 'issued-token' })),
      logout: jest.fn(() => Promise.resolve(undefined)),
      listUsers: jest.fn(() => Promise.resolve([])),
      createUser: jest.fn(() => Promise.resolve({ id: 'new-user' })),
      updateUser: jest.fn(() => Promise.resolve({ id: 'updated-user' })),
      listAuditEvents: jest.fn(() => Promise.resolve([])),
    };
    const module = await Test.createTestingModule({
      controllers: [
        HealthController,
        AuthController,
        OrdersController,
        ProductController,
        QuickProductController,
        UploadsController,
        TrackingController,
      ],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: OrdersService,
          useValue: {
            findAll: jest.fn(() => Promise.resolve([])),
            getSummary: jest.fn(() => Promise.resolve({})),
            lookupPublicTracking: jest.fn(() =>
              Promise.resolve({
                orderNumber: 'GD-000123',
                status: 'producing',
              }),
            ),
          },
        },
        { provide: OrdersSseService, useValue: { asObservable: jest.fn() } },
        {
          provide: ProductService,
          useValue: {
            findAll: jest.fn(() => Promise.resolve([])),
            create: jest.fn(() => Promise.resolve({ code: 'TEST' })),
            delete: jest.fn(() => Promise.resolve({ code: 'TEST' })),
          },
        },
        {
          provide: QuickProductService,
          useValue: { findAll: jest.fn(() => Promise.resolve([])) },
        },
        {
          provide: UploadsService,
          useValue: {
            listUploads: jest.fn(() => Promise.resolve([])),
            deleteUploadById: jest.fn(() =>
              Promise.resolve({ id: 'upload-1' }),
            ),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => app.close());

  it('keeps only health, login, and upload creation explicitly public', async () => {
    await request(server).get('/health').expect(200);
    await request(server)
      .post('/auth/login')
      .send({ username: 'staff', password: 'secret' })
      .expect(201);
    await request(server).post('/uploads').expect(400);
    await request(server)
      .post('/tracking/lookup')
      .send({ orderNumber: 'GD-000123', phoneSuffix: '5678' })
      .expect(201);
  });

  it.each([
    ['auth identity', '/auth/me'],
    ['orders', '/orders'],
    ['products', '/products'],
    ['quick products', '/quick-products'],
    ['uploads', '/uploads'],
  ])('rejects anonymous access to %s', async (_name, path) => {
    await request(server).get(path).expect(401);
  });

  it.each(['/orders', '/products', '/quick-products', '/uploads'])(
    'allows authenticated staff to read %s',
    async (path) => {
      await request(server).get(path).set(bearer('staff')).expect(200);
    },
  );

  it('blocks staff from manager/admin mutations and staff administration', async () => {
    await request(server)
      .post('/products')
      .set(bearer('staff'))
      .send({})
      .expect(403);
    await request(server)
      .delete('/uploads/upload-1')
      .set(bearer('staff'))
      .expect(403);
    await request(server).get('/auth/users').set(bearer('staff')).expect(403);
  });

  it('allows managers to mutate products but keeps destructive product access admin-only', async () => {
    await request(server)
      .post('/products')
      .set(bearer('manager'))
      .send({})
      .expect(201);
    await request(server)
      .delete('/products/product-1')
      .set(bearer('manager'))
      .expect(403);
  });

  it('allows admins through admin-only controller policies', async () => {
    await request(server).get('/auth/users').set(bearer('admin')).expect(200);
    await request(server)
      .delete('/products/product-1')
      .set(bearer('admin'))
      .expect(200);
    await request(server)
      .delete('/uploads/upload-1')
      .set(bearer('admin'))
      .expect(200);
  });
});
