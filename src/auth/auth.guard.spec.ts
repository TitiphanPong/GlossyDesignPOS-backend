import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';

function contextWithAuthorization(authorization?: string) {
  const request = { headers: { authorization } };
  return {
    request,
    context: {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
      switchToHttp: () => ({ getRequest: () => request }),
    },
  };
}

describe('AuthGuard', () => {
  it('allows explicitly public handlers without a token', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValueOnce(true),
    } as unknown as Reflector;
    const authService = { authenticate: jest.fn() } as unknown as AuthService;
    const guard = new AuthGuard(reflector, authService);

    await expect(
      guard.canActivate(contextWithAuthorization().context as never),
    ).resolves.toBe(true);
  });

  it('rejects protected handlers without a bearer token', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const authService = { authenticate: jest.fn() } as unknown as AuthService;
    const guard = new AuthGuard(reflector, authService);

    await expect(
      guard.canActivate(contextWithAuthorization().context as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches an authenticated user and enforces roles', async () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(['admin']),
    } as unknown as Reflector;
    const authService = {
      authenticate: jest
        .fn()
        .mockResolvedValue({ id: '1', username: 'staff', role: 'staff' }),
    } as unknown as AuthService;
    const guard = new AuthGuard(reflector, authService);

    await expect(
      guard.canActivate(
        contextWithAuthorization('Bearer valid').context as never,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
