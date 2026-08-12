import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../src/auth/auth.guard';
import { Public, Roles } from '../src/auth/auth.decorators';
import { AuthService } from '../src/auth/auth.service';

@Controller('matrix')
class AuthorizationMatrixController {
  @Public()
  @Get('public')
  publicRoute() {
    return { ok: true };
  }

  @Get('staff')
  staffRoute() {
    return { ok: true };
  }

  @Roles('admin')
  @Get('admin')
  adminRoute() {
    return { ok: true };
  }
}

describe('Authorization matrix (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    const authService = {
      authenticate: jest.fn((token: string) =>
        Promise.resolve(
          token === 'staff-token'
            ? { id: '1', username: 'staff', role: 'staff' }
            : token === 'admin-token'
              ? { id: '2', username: 'admin', role: 'admin' }
              : null,
        ),
      ),
    };
    const module = await Test.createTestingModule({
      controllers: [AuthorizationMatrixController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => app.close());

  it('allows public routes anonymously and rejects protected routes', async () => {
    await request(server).get('/matrix/public').expect(200);
    await request(server).get('/matrix/staff').expect(401);
  });

  it('allows authenticated staff but blocks admin-only routes', async () => {
    await request(server)
      .get('/matrix/staff')
      .set('Authorization', 'Bearer staff-token')
      .expect(200);
    await request(server)
      .get('/matrix/admin')
      .set('Authorization', 'Bearer staff-token')
      .expect(403);
  });

  it('allows admins through admin-only routes and rejects invalid sessions', async () => {
    await request(server)
      .get('/matrix/admin')
      .set('Authorization', 'Bearer admin-token')
      .expect(200);
    await request(server)
      .get('/matrix/staff')
      .set('Authorization', 'Bearer invalid')
      .expect(401);
  });
});
