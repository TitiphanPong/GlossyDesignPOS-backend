import { BadRequestException } from '@nestjs/common';
import type { Model } from 'mongoose';
import type { OrderDocument } from '../orders/orders.schema';
import type { NotificationDocument } from './notifications.schema';
import { NotificationsService } from './notifications.service';

function notification(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    _id: 'notification-1',
    type: 'payment_outstanding',
    category: 'action_required',
    priority: 'high',
    status: 'active',
    title: 'ยอดค้าง',
    isRead: false,
    createdAt: new Date('2026-08-27T10:00:00.000Z'),
    updatedAt: new Date('2026-08-27T10:00:00.000Z'),
    ...overrides,
  };
}

describe('NotificationsService action center', () => {
  it('returns one actionable snapshot with operational summary and priority ordering', async () => {
    const exec = jest.fn().mockResolvedValue([
      notification({ _id: 'payment', amount: 350 }),
      notification({
        _id: 'upload',
        type: 'upload_review_required',
        entityType: 'upload',
        amount: undefined,
        priority: 'normal',
      }),
      notification({
        _id: 'late',
        type: 'order_overdue',
        entityType: 'order',
        amount: undefined,
        priority: 'critical',
        createdAt: new Date('2026-08-27T09:00:00.000Z'),
      }),
    ]);
    const sort = jest.fn().mockReturnValue({ exec });
    type ActionCenterFilter = {
      status: string;
      type: { $in: readonly string[] };
    };
    const find: jest.MockedFunction<
      (filter: ActionCenterFilter) => { sort: typeof sort }
    > = jest.fn().mockReturnValue({ sort });
    const service = new NotificationsService(
      { find } as unknown as Model<NotificationDocument>,
      {} as Model<OrderDocument>,
    );

    const result = await service.getActionCenter();

    expect(find).toHaveBeenCalledTimes(1);
    const filter = find.mock.calls[0]?.[0];
    expect(filter?.status).toBe('active');
    expect(filter?.type.$in).toContain('payment_outstanding');
    expect(filter?.type.$in).not.toContain('order_created');
    expect(result.summary).toEqual({
      total: 3,
      critical: 1,
      outstandingAmount: 350,
      filesWaiting: 1,
    });
    expect(result.items.map((item) => item._id)).toEqual([
      'late',
      'payment',
      'upload',
    ]);
  });

  it('does not allow action-required conditions to be manually resolved', async () => {
    const findById = jest.fn().mockResolvedValue(notification());
    const service = new NotificationsService(
      { findById } as unknown as Model<NotificationDocument>,
      {} as Model<OrderDocument>,
    );

    await expect(
      service.resolveNotification('notification-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('does not allow action-required conditions to be dismissed while active', async () => {
    const findById = jest.fn().mockResolvedValue(notification());
    const service = new NotificationsService(
      { findById } as unknown as Model<NotificationDocument>,
      {} as Model<OrderDocument>,
    );

    await expect(
      service.dismissNotification('notification-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
