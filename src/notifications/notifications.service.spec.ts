import { BadRequestException } from '@nestjs/common';
import type { Model } from 'mongoose';
import type { OrderDocument } from '../orders/orders.schema';
import type { StockItemDocument } from '../inventory/schemas/stock-item.schema';
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
        _id: 'failed',
        type: 'payment_failed',
        entityType: 'payment',
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
      {} as Model<StockItemDocument>,
    );
    jest.spyOn(service, 'syncLowStockNotifications').mockResolvedValue();

    const result = await service.getActionCenter();

    expect(find).toHaveBeenCalledTimes(1);
    const filter = find.mock.calls[0]?.[0];
    expect(filter?.status).toBe('active');
    expect(filter?.type.$in).toContain('payment_outstanding');
    expect(filter?.type.$in).not.toContain('order_created');
    expect(filter?.type.$in).not.toContain('order_overdue');
    expect(result.summary).toEqual({
      total: 3,
      critical: 1,
      outstandingAmount: 350,
      filesWaiting: 1,
    });
    expect(result.items.map((item) => item._id)).toEqual([
      'failed',
      'payment',
      'upload',
    ]);
  });

  it('does not allow action-required conditions to be manually resolved', async () => {
    const findById = jest.fn().mockResolvedValue(notification());
    const service = new NotificationsService(
      { findById } as unknown as Model<NotificationDocument>,
      {} as Model<OrderDocument>,
      {} as Model<StockItemDocument>,
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
      {} as Model<StockItemDocument>,
    );

    await expect(
      service.dismissNotification('notification-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reuses the same notification key with an atomic upsert so resolved conditions can reopen', async () => {
    const saved = notification({
      _id: 'stock-low',
      type: 'low_stock',
      entityType: 'stock',
      entityId: 'stock-1',
    }) as NotificationDocument;
    const findOneAndUpdate = jest.fn().mockResolvedValue(saved);
    const service = new NotificationsService(
      { findOneAndUpdate } as unknown as Model<NotificationDocument>,
      {} as Model<OrderDocument>,
      {} as Model<StockItemDocument>,
    );

    await service.createNotification({
      type: 'low_stock',
      category: 'action_required',
      title: 'สต็อกต่ำ กระดาษ A4',
      entityType: 'stock',
      entityId: 'stock-1',
      notificationKey: 'low_stock:stock-1',
    });

    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update, options] = findOneAndUpdate.mock.calls[0] as [
      { notificationKey: string },
      {
        $set: { status: string; isRead: boolean };
        $setOnInsert: { notificationKey: string };
        $unset: { resolvedAt: number; dismissedAt: number };
      },
      { new: boolean; upsert: boolean; setDefaultsOnInsert: boolean },
    ];
    expect(update.$set.status).toBe('active');
    expect(update.$set.isRead).toBe(false);
    expect(update.$setOnInsert).toEqual({
      notificationKey: 'low_stock:stock-1',
    });
    expect(update.$unset).toEqual({ resolvedAt: 1, dismissedAt: 1 });
    expect(options).toEqual({
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    });
  });

  it('creates one low-stock action per active item and resolves stale low-stock conditions', async () => {
    const stockExec = jest.fn().mockResolvedValue([
      {
        _id: '64b000000000000000000011',
        name: 'กระดาษ A4 80 แกรม',
        onHand: 5,
        minimumLevel: 10,
        unit: 'รีม',
      },
    ]);
    const stockFind = jest.fn().mockReturnValue({ exec: stockExec });
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    const service = new NotificationsService(
      { updateMany } as unknown as Model<NotificationDocument>,
      {} as Model<OrderDocument>,
      { find: stockFind } as unknown as Model<StockItemDocument>,
    );
    const createSpy = jest
      .spyOn(service, 'createNotification')
      .mockResolvedValue(notification({ type: 'low_stock' }) as never);

    await service.syncLowStockNotifications();

    expect(stockFind).toHaveBeenCalledWith({
      active: { $ne: false },
      $expr: { $lte: ['$onHand', '$minimumLevel'] },
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'low_stock',
        category: 'action_required',
        entityType: 'stock',
        entityId: '64b000000000000000000011',
        notificationKey: 'low_stock:64b000000000000000000011',
        action: { label: 'เปิดสต็อก', action: 'open_stock' },
      }),
    );
    expect(updateMany).toHaveBeenCalledTimes(1);
    const [resolveFilter, resolveUpdate] = updateMany.mock.calls[0] as [
      {
        type: string;
        status: string;
        notificationKey: { $nin: string[] };
      },
      { $set: { status: string; resolvedAt: Date } },
    ];
    expect(resolveFilter).toEqual({
      type: 'low_stock',
      status: 'active',
      notificationKey: {
        $nin: ['low_stock:64b000000000000000000011'],
      },
    });
    expect(resolveUpdate.$set.status).toBe('resolved');
    expect(resolveUpdate.$set.resolvedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['outstanding balance', 'partial', 125],
    ['fully paid balance', 'paid', 0],
  ] as const)(
    'resolves ready/pickup actions when workflow is delivered with %s',
    async (_label, financialStatus, remainingTotal) => {
      const order = {
        workflowStatus: 'delivered',
        status: financialStatus,
        remainingTotal,
        statusHistory: [],
      } as unknown as OrderDocument;
      const findById = jest.fn().mockResolvedValue(order);
      const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 1 });
      const service = new NotificationsService(
        { updateMany } as unknown as Model<NotificationDocument>,
        { findById } as unknown as Model<OrderDocument>,
        {} as Model<StockItemDocument>,
      );

      await service.autoResolvePickupNotifications('order-1');

      const [filter, update] = updateMany.mock.calls[0] as unknown as [
        Record<string, unknown>,
        { $set: { status: string; resolvedAt: Date } },
      ];
      expect(filter).toEqual({
        orderId: 'order-1',
        type: { $in: ['order_ready_for_pickup', 'order_pickup_delayed'] },
        status: 'active',
      });
      expect(update.$set.status).toBe('resolved');
      expect(update.$set.resolvedAt).toBeInstanceOf(Date);
    },
  );

  it('does not treat financial paid status as a delivered production milestone', async () => {
    const order = {
      workflowStatus: 'ready_for_pickup',
      status: 'paid',
      remainingTotal: 0,
      statusHistory: [],
    } as unknown as OrderDocument;
    const findById = jest.fn().mockResolvedValue(order);
    const updateMany = jest.fn();
    const service = new NotificationsService(
      { updateMany } as unknown as Model<NotificationDocument>,
      { findById } as unknown as Model<OrderDocument>,
      {} as Model<StockItemDocument>,
    );

    await service.autoResolvePickupNotifications('order-1');

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('keeps legacy age-based overdue and unconfirmed notification rules dormant', async () => {
    const orderFind = jest.fn();
    const notificationFindOne = jest.fn();
    const service = new NotificationsService(
      {
        findOne: notificationFindOne,
      } as unknown as Model<NotificationDocument>,
      { find: orderFind } as unknown as Model<OrderDocument>,
      {} as Model<StockItemDocument>,
    );
    const createSpy = jest.spyOn(service, 'createNotification');

    await service.checkAndNotifyOverdueOrders();
    await service.checkAndNotifyUnconfirmedOrders();

    expect(orderFind).not.toHaveBeenCalled();
    expect(notificationFindOne).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });
});
