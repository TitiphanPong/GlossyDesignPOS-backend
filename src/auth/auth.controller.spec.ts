import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  const admin = {
    id: '507f1f77bcf86cd799439011',
    username: 'admin',
    role: 'admin' as const,
  };

  it('passes the authenticated actor to user-management commands', async () => {
    const createUser = jest.fn().mockResolvedValue({ id: 'user-1' });
    const updateUser = jest.fn().mockResolvedValue({ id: 'user-1' });
    const authService = {
      createUser,
      updateUser,
    } as unknown as AuthService;
    const controller = new AuthController(authService);

    await controller.createUser(
      { username: 'cashier', password: 'long-password', role: 'staff' },
      { user: admin },
    );
    await controller.updateUser('user-1', { active: false }, { user: admin });

    expect(createUser).toHaveBeenCalledWith(
      { username: 'cashier', password: 'long-password', role: 'staff' },
      admin,
    );
    expect(updateUser).toHaveBeenCalledWith('user-1', { active: false }, admin);
  });

  it('revokes the bearer session on logout', async () => {
    const logout = jest.fn().mockResolvedValue(undefined);
    const authService = { logout } as unknown as AuthService;
    const controller = new AuthController(authService);

    await controller.logout({ user: admin }, 'Bearer opaque-token');

    expect(logout).toHaveBeenCalledWith('opaque-token', admin);
  });
});
