import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuditService } from '../src/auth/audit.service';
import { AuthGuard } from '../src/auth/auth.guard';
import { AuthService } from '../src/auth/auth.service';
import { CustomersController } from '../src/customers/customers.controller';
import { CustomersService } from '../src/customers/customers.service';

describe('Customers privacy boundary (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  let detailMock: jest.Mock;

  beforeAll(async () => {
    const authService = {
      authenticate: jest.fn((token: string) =>
        Promise.resolve(
          token === 'staff-token'
            ? {
                id: '64b000000000000000000001',
                username: 'staff',
                role: 'staff',
              }
            : null,
        ),
      ),
    };
    detailMock = jest.fn().mockResolvedValue({
      customer: { customerCode: 'CUS-1', displayName: 'Private customer' },
      orders: [],
      orderPagination: { page: 1, limit: 10, total: 0 },
    });
    const customersService = {
      list: jest
        .fn()
        .mockResolvedValue({ data: [], page: 1, limit: 20, total: 0 }),
      detail: detailMock,
      create: jest.fn(),
      update: jest.fn(),
    };
    const module = await Test.createTestingModule({
      controllers: [CustomersController],
      providers: [
        { provide: CustomersService, useValue: customersService },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(true) },
        },
        { provide: AuthService, useValue: authService },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => app.close());

  it('does not expose customer list or detail anonymously', async () => {
    await request(server).get('/customers').expect(401);
    await request(server)
      .get('/customers/64b000000000000000000002')
      .expect(401);
  });

  it('allows authenticated staff to page identity-scoped Order history', async () => {
    await request(server)
      .get('/customers')
      .set('Authorization', 'Bearer staff-token')
      .expect(200);
    await request(server)
      .get('/customers/64b000000000000000000002?orderPage=3&orderLimit=25')
      .set('Authorization', 'Bearer staff-token')
      .expect(200);

    expect(detailMock).toHaveBeenLastCalledWith(
      '64b000000000000000000002',
      expect.objectContaining({ orderPage: 3, orderLimit: 25 }),
    );
  });
});
