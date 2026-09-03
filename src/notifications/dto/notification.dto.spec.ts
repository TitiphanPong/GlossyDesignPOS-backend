import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ActiveNotificationsQueryDto,
  ListNotificationsQueryDto,
  UpdateActionCenterUserStateDto,
} from './notification.dto';

describe('notification query DTOs', () => {
  it('transforms boolean and pagination query strings', async () => {
    const query = plainToInstance(ListNotificationsQueryDto, {
      isRead: 'false',
      limit: '25',
      skip: '5',
    });

    await expect(validate(query)).resolves.toHaveLength(0);
    expect(query).toEqual(
      expect.objectContaining({ isRead: false, limit: 25, skip: 5 }),
    );
  });

  it('rejects unknown active-notification categories', async () => {
    const query = plainToInstance(ActiveNotificationsQueryDto, {
      category: 'unknown',
    });

    await expect(validate(query)).resolves.not.toHaveLength(0);
  });

  it('accepts a bounded Action Center snooze request', async () => {
    const body = plainToInstance(UpdateActionCenterUserStateDto, {
      notificationIds: ['notification-1', 'notification-2'],
      action: 'snooze',
      snoozeMinutes: '60',
    });

    await expect(validate(body)).resolves.toHaveLength(0);
    expect(body.snoozeMinutes).toBe(60);
  });

  it('rejects snooze requests outside the supported window', async () => {
    const body = plainToInstance(UpdateActionCenterUserStateDto, {
      notificationIds: ['notification-1'],
      action: 'snooze',
      snoozeMinutes: 5,
    });

    await expect(validate(body)).resolves.not.toHaveLength(0);
  });
});
