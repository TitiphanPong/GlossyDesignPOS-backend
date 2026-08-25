import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ActiveNotificationsQueryDto,
  ListNotificationsQueryDto,
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
});
