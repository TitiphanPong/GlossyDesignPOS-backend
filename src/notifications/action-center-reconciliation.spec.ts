import { model, Model } from 'mongoose';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Notification,
  NotificationDocument,
  NotificationSchema,
} from './notifications.schema';
import { NotificationsService } from './notifications.service';
import { OrderDocument } from '../orders/orders.schema';
import { Upload } from '../uploads/schemas/upload.schema';
import { UploadStage, UploadStatus } from '../uploads/uploads.enums';
import { StockItemDocument } from '../inventory/schemas/stock-item.schema';
import { NotificationUserStateDocument } from './notification-user-state.schema';

const NotificationModel = model<Notification>(
  'ActionCenterFixtureNotification',
  NotificationSchema,
);
type Operation = {
  updateOne: {
    filter: Record<string, unknown>;
    upsert?: boolean;
    timestamps?: boolean;
    update: {
      $set?: Record<string, unknown>;
      $unset?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
    };
  };
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_key: string, entry: unknown) =>
    typeof entry === 'string' && /^\d{4}-\d\d-\d\dT/.test(entry)
      ? new Date(entry)
      : entry,
  ) as T;
}

function matches(
  row: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or')
      return (expected as Record<string, unknown>[]).some((entry) =>
        matches(row, entry),
      );
    const value = row[key];
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Date)
    ) {
      return Object.entries(expected).every(([operator, operand]) => {
        if (operator === '$eq')
          return JSON.stringify(value) === JSON.stringify(operand);
        if (operator === '$exists') return (value !== undefined) === operand;
        if (operator === '$in') return (operand as unknown[]).includes(value);
        if (operator === '$nin') return !(operand as unknown[]).includes(value);
        if (operator === '$ne') return value !== operand;
        if (operator === '$gt') return Number(value) > Number(operand);
        if (operator === '$lte') return Number(value) <= Number(operand);
        throw new Error(`Unsupported fixture operator ${operator}`);
      });
    }
    return value instanceof Date && expected instanceof Date
      ? value.getTime() === expected.getTime()
      : Array.isArray(value)
        ? value.includes(expected)
        : String(value) === String(expected);
  });
}

function harness() {
  const orders: OrderDocument[] = [];
  const uploads: Upload[] = [];
  const notifications: NotificationDocument[] = [];
  const states: NotificationUserStateDocument[] = [];
  const query = <T>(rows: T[]) => {
    const snapshot = clone(rows);
    const chain = {
      exec: () => Promise.resolve(snapshot),
      select: () => chain,
      lean: () => chain,
      sort: () => chain,
    };
    return chain;
  };
  const orderFind = jest.fn((filter: Record<string, unknown>) =>
    query(
      orders.filter((row) =>
        matches(
          {
            ...row,
            'statusHistory.status': row.statusHistory?.map(
              (entry) => entry.status,
            ),
          },
          filter,
        ),
      ),
    ),
  );
  const uploadFind = jest.fn(
    (pipeline: { $match: Record<string, unknown> }[]) =>
      query(
        uploads
          .filter((row) => matches({ ...row }, pipeline[0].$match))
          .map((row) => ({ ...row, fileCount: row.files.length })),
      ),
  );
  const apply = (operation: Operation) => {
    const { update } = operation.updateOne;
    const filter = clone(operation.updateOne.filter);
    let row = notifications.find((item) =>
      filter._id
        ? String(item._id) === filter._id
        : item.notificationKey === filter.notificationKey,
    );
    if (
      row &&
      !matches(clone(row.toObject()) as Record<string, unknown>, filter)
    )
      return undefined;
    if (!row) {
      if (!operation.updateOne.upsert) return undefined;
      row = new NotificationModel({
        notificationKey: filter.notificationKey,
        ...update.$set,
        ...update.$setOnInsert,
        createdAt: new Date(),
        isRead: false,
      });
      notifications.push(row);
    }
    row.set(update.$set ?? {});
    for (const field of Object.keys(update.$unset ?? {}))
      row.set(field, undefined);
    if (operation.updateOne.timestamps !== false) row.updatedAt = new Date();
    return row;
  };
  const beforeBulk = { run: async () => {} };
  const beforeExisting = { run: async () => {} };
  const bulkWrite = jest.fn(async (operations: Operation[]) => {
    await beforeBulk.run();
    operations.forEach(apply);
  });
  const notificationModel = {
    find: (filter: Record<string, unknown>) => {
      const result = query(
        notifications
          .map((item) => clone(item.toObject()))
          .filter((row) => matches(row as Record<string, unknown>, filter)),
      );
      if (filter.notificationKey) {
        result.exec = async () => {
          await beforeExisting.run();
          return clone(
            notifications
              .map((item) => item.toObject())
              .filter((row) => matches(row as Record<string, unknown>, filter)),
          );
        };
      }
      return result;
    },
    bulkWrite,
    findOneAndUpdate: (
      filter: Operation['updateOne']['filter'],
      update: Operation['updateOne']['update'],
    ) =>
      Promise.resolve(apply({ updateOne: { filter, update, upsert: true } })),
    updateMany: (
      filter: {
        relatedUploadId?: string;
        orderId?: string;
        type: { $in: string[] };
      },
      update: Operation['updateOne']['update'],
    ) => {
      for (const row of notifications) {
        if (
          row.status === 'active' &&
          filter.type.$in.includes(row.type) &&
          (!filter.relatedUploadId ||
            row.relatedUploadId === filter.relatedUploadId) &&
          (!filter.orderId || row.orderId === filter.orderId)
        )
          apply({ updateOne: { filter: { _id: row._id }, update } });
      }
      return Promise.resolve();
    },
  };
  const service = new NotificationsService(
    notificationModel as unknown as Model<NotificationDocument>,
    {
      find: orderFind,
      findById: (id: string) =>
        Promise.resolve(orders.find((order) => String(order._id) === id)),
    } as unknown as Model<OrderDocument>,
    {} as Model<StockItemDocument>,
    undefined,
    {
      find: ({ userId }: { userId: string }) =>
        query(states.filter((state) => state.userId === userId)),
    } as unknown as Model<NotificationUserStateDocument>,
    { aggregate: uploadFind } as unknown as Model<Upload>,
  );
  jest.spyOn(service, 'syncLowStockNotifications').mockResolvedValue();
  jest.spyOn(service, 'syncOverdueProductionNotifications').mockResolvedValue();
  return {
    service,
    orders,
    uploads,
    notifications,
    states,
    bulkWrite,
    orderFind,
    uploadFind,
    beforeBulk,
    beforeExisting,
  };
}

const order = (fields: Record<string, unknown> = {}) =>
  ({
    _id: 'order-1',
    customerName: 'Customer',
    orderNumber: 'ORD-1',
    status: 'partial',
    workflowStatus: 'ready_for_pickup',
    remainingTotal: 0.1,
    ...fields,
  }) as unknown as OrderDocument;
const upload = (fields: Partial<Upload> = {}) =>
  ({
    uploadId: 'upload-1',
    orderCode: 'UPLOAD-CODE',
    status: UploadStatus.PENDING,
    files: [],
    ...fields,
  }) as Upload;

describe('Action Center persisted-state reconciliation', () => {
  it('keeps the pre-source baseline when a same-ms hook runs before the desired-key read', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T00:00:00Z'));
    const h = harness();
    h.orders.push(order());
    await h.service.getActionCenter();
    h.orders[0].remainingTotal = 0.2;
    h.beforeExisting.run = async () => {
      h.orders[0].remainingTotal = 0.3;
      await h.service.handleOrderPaymentState(h.orders[0]);
    };
    await h.service.syncOrderAndUploadNotifications();
    expect(
      h.notifications.find((item) => item.type === 'payment_outstanding')
        ?.amount,
    ).toBe(0.3);
  });
  it('serializes the shared FE/BE snapshot contract through the real DTO and summary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T00:00:00Z'));
    const fixture = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../test/fixtures/action-center.snapshot.json'),
        'utf8',
      ),
    ) as {
      summary: unknown;
      items: (Record<string, unknown> & {
        _id: string;
        acknowledgedAt?: string;
        snoozedUntil?: string;
      })[];
    };
    const h = harness();
    jest
      .spyOn(h.service, 'syncOrderAndUploadNotifications')
      .mockResolvedValue();
    for (const item of fixture.items) {
      h.notifications.push(new NotificationModel(item));
      if (item.acknowledgedAt || item.snoozedUntil)
        h.states.push({
          userId: 'fixture-user',
          notificationId: item._id,
          updatedAt: new Date(),
          ...(item.acknowledgedAt
            ? { acknowledgedAt: new Date(item.acknowledgedAt) }
            : {}),
          ...(item.snoozedUntil
            ? { snoozedUntil: new Date(item.snoozedUntil) }
            : {}),
        } as NotificationUserStateDocument);
    }
    expect(
      JSON.parse(
        JSON.stringify(await h.service.getActionCenter('fixture-user')),
      ),
    ).toEqual(fixture);
  });
  it.each(['payment', 'upload'] as const)(
    'preserves newer %s facts even at the same millisecond',
    async (scenario) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-10T00:00:00Z'));
      const h = harness();
      if (scenario === 'payment') h.orders.push(order());
      else h.uploads.push(upload());
      await h.service.getActionCenter();
      if (scenario === 'payment') h.orders[0].remainingTotal = 0.2;
      else h.uploads[0].stage = UploadStage.PENDING;
      h.beforeBulk.run = async () => {
        if (scenario === 'payment') {
          h.orders[0].remainingTotal = 0.3;
          await h.service.handleOrderPaymentState(h.orders[0]);
        } else {
          await h.service.handleUploadReview(h.uploads[0]);
          h.uploads[0].stage = UploadStage.WAITING_DOWNLOAD;
          await h.service.handleUploadReview(h.uploads[0]);
        }
      };
      await h.service.syncOrderAndUploadNotifications();
      const item = h.notifications.find(
        (row) =>
          row.type ===
          (scenario === 'payment'
            ? 'payment_outstanding'
            : 'upload_review_required'),
      );
      expect(item?.status).toBe('active');
      if (scenario === 'payment') expect(item?.amount).toBe(0.3);
      else expect(item?.lastInactiveAt).toEqual(new Date());
    },
  );

  it.each([
    [{ writeErrors: [{ code: 11000 }] }, true],
    [
      {
        writeErrors: [{ code: 11000 }],
        result: { getWriteConcernError: () => ({ code: 64 }) },
      },
      false,
    ],
    [{ writeErrors: [{ code: 121 }] }, false],
  ])(
    'only tolerates duplicate-key-only bulk failure %#',
    async (failure, tolerated) => {
      const h = harness();
      h.orders.push(order());
      h.bulkWrite.mockRejectedValueOnce(failure);
      const repair = h.service.syncOrderAndUploadNotifications();
      if (tolerated) await expect(repair).resolves.toBeUndefined();
      else await expect(repair).rejects.toBe(failure);
    },
  );

  it.each(['delivered', 'cancelled'])(
    'reconciles inactive %s sources reachable only by active notification ObjectIds',
    async (workflowStatus) => {
      const h = harness();
      const id = '64b000000000000000000001';
      h.orders.push(
        order({
          _id: id,
          status: workflowStatus,
          workflowStatus,
          remainingTotal: 0,
        }),
      );
      for (const type of [
        'payment_outstanding',
        'payment_failed',
        'order_ready_for_pickup',
        'order_pickup_delayed',
      ])
        h.notifications.push(
          new NotificationModel({
            type,
            orderId: id,
            notificationKey: type + ':' + id,
            title: type,
            status: 'active',
          }),
        );
      expect((await h.service.getActionCenter()).items).toHaveLength(0);
      expect(h.notifications.every((item) => item.status === 'resolved')).toBe(
        true,
      );
    },
  );

  it('includes a legacy ready history before a later financial status, with no remaining balance', async () => {
    const h = harness();
    h.orders.push(
      order({
        workflowStatus: undefined,
        status: 'paid',
        remainingTotal: 0,
        statusHistory: [{ status: 'ready_for_pickup' }, { status: 'paid' }],
      }),
    );
    expect(
      (await h.service.getActionCenter()).items.map((item) => item.type),
    ).toEqual(['order_ready_for_pickup']);
  });

  it('projects file counts and clears removed upload linkage and customer context', async () => {
    const h = harness();
    h.uploads.push(
      upload({
        linkedOrderId: '64b000000000000000000001',
        linkedOrderNumber: 'ORDER',
        customerName: 'Customer',
      }),
    );
    await h.service.getActionCenter();
    h.uploads[0].linkedOrderId = undefined;
    h.uploads[0].linkedOrderNumber = undefined;
    h.uploads[0].customerName = undefined;
    await h.service.getActionCenter();
    expect(h.notifications[0].orderId).toBeUndefined();
    expect(h.notifications[0].orderCode).toBeUndefined();
    expect(h.notifications[0].customerName).toBeUndefined();
    expect(h.uploadFind.mock.calls[0][0][1]).toEqual({
      $project: {
        uploadId: 1,
        status: 1,
        stage: 1,
        customerName: 1,
        displayName: 1,
        linkedOrderId: 1,
        linkedOrderNumber: 1,
        fileCount: { $size: { $ifNull: ['$files', []] } },
      },
    });
  });

  it.each(['payment', 'upload', 'absent-key'] as const)(
    'does not overwrite a newer %s hook while repair is paused',
    async (scenario) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-10T00:00:00Z'));
      const h = harness();
      if (scenario === 'upload') h.uploads.push(upload());
      else h.orders.push(order());
      if (scenario !== 'absent-key') await h.service.getActionCenter();
      if (scenario === 'upload') h.uploads[0].stage = UploadStage.PENDING;
      else h.orders[0].remainingTotal = 0.2;
      jest.setSystemTime(new Date('2026-09-10T00:01:00Z'));
      let release!: () => void;
      let signal!: () => void;
      const reached = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      h.beforeBulk.run = async () => {
        signal();
        await paused;
      };
      const repair = h.service.syncOrderAndUploadNotifications();
      await reached;
      jest.setSystemTime(new Date('2026-09-10T00:02:00Z'));
      if (scenario === 'upload') {
        await h.service.handleUploadReview(h.uploads[0]);
        jest.setSystemTime(new Date('2026-09-10T00:03:00Z'));
        h.uploads[0].stage = UploadStage.WAITING_DOWNLOAD;
        await h.service.handleUploadReview(h.uploads[0]);
      } else {
        if (scenario === 'absent-key')
          await h.service.handleOrderPaymentState(h.orders[0]);
        h.orders[0].remainingTotal = 0;
        await h.service.autoResolvePaymentNotifications('order-1');
      }
      const beforeResume = clone(h.notifications);
      release();
      await repair;
      const relevantType =
        scenario === 'upload'
          ? 'upload_review_required'
          : 'payment_outstanding';
      expect(
        clone(h.notifications).filter((item) => item.type === relevantType),
      ).toEqual(beforeResume.filter((item) => item.type === relevantType));
    },
  );

  it('removes personally acknowledged/snoozed critical items from new while retaining all and critical counts', async () => {
    const h = harness();
    const now = new Date();
    h.notifications.push(
      new NotificationModel({
        type: 'payment_failed',
        title: 'Failure',
        category: 'action_required',
        priority: 'critical',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }),
    );
    h.states.push({
      userId: 'A',
      notificationId: String(h.notifications[0]._id),
      acknowledgedAt: now,
      updatedAt: now,
    } as NotificationUserStateDocument);
    expect((await h.service.getActionCenter('A')).summary).toMatchObject({
      total: 1,
      critical: 1,
      attention: 0,
      acknowledged: 1,
    });
    expect((await h.service.getActionCenter('B')).summary).toMatchObject({
      total: 1,
      critical: 1,
      attention: 1,
    });
    h.states[0].acknowledgedAt = undefined;
    h.states[0].snoozedUntil = new Date(Date.now() + 60_000);
    expect((await h.service.getActionCenter('A')).summary).toMatchObject({
      total: 1,
      critical: 1,
      attention: 0,
      snoozed: 1,
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('repairs missed hooks, updated balances, legacy readiness and delivered outstanding independently', async () => {
    const h = harness();
    h.orders.push(
      order({
        workflowStatus: undefined,
        statusHistory: [{ status: 'ready_for_pickup' }],
      }),
    );
    h.uploads.push(
      upload({
        customerName: 'Upload customer',
        linkedOrderId: 'real-order',
        linkedOrderNumber: 'ORD-REAL',
      }),
    );
    const initial = await h.service.getActionCenter();
    expect(initial.summary).toMatchObject({
      total: 3,
      outstandingAmount: 0.1,
      filesWaiting: 1,
    });
    expect(
      initial.items.find((item) => item.type === 'upload_review_required'),
    ).toMatchObject({
      customerName: 'Upload customer',
      orderId: 'real-order',
      orderCode: 'ORD-REAL',
    });
    h.orders[0].workflowStatus = 'delivered';
    h.orders[0].remainingTotal = 0.2;
    const delivered = await h.service.getActionCenter();
    expect(delivered.summary.outstandingAmount).toBe(0.2);
    expect(
      delivered.items.some((item) => item.type === 'order_ready_for_pickup'),
    ).toBe(false);
    h.orders[0].status = 'cancelled';
    const cancelled = await h.service.getActionCenter();
    expect(cancelled.summary.outstandingAmount).toBe(0);
    expect(cancelled.items.map((item) => item.type)).toEqual([
      'upload_review_required',
    ]);
  });

  it('closes payment and pickup from the committed cancellation hook even with remaining money', async () => {
    const h = harness();
    h.orders.push(order());
    await h.service.getActionCenter();
    h.orders[0].status = 'cancelled';
    h.orders[0].workflowStatus = 'cancelled';
    await h.service.handleOrderStatusChange({
      _id: 'order-1',
      status: 'cancelled',
      customerName: 'Customer',
    });
    expect(
      h.notifications.every(
        (item) => item.status === 'resolved' && item.lastInactiveAt,
      ),
    ).toBe(true);
  });

  it.each([
    [undefined, UploadStatus.PENDING, true],
    [UploadStage.WAITING_DOWNLOAD, UploadStatus.PENDING, true],
    [UploadStage.PENDING, UploadStatus.PENDING, false],
    [UploadStage.COMPLETED, UploadStatus.PENDING, false],
    [UploadStage.WAITING_DOWNLOAD, UploadStatus.COMPLETED, false],
    [UploadStage.PENDING, UploadStatus.COMPLETED, false],
  ])(
    'matches storage waiting normalization for %s / %s',
    async (stage, status, waiting) => {
      const h = harness();
      const row = upload({ stage, status });
      h.uploads.push(row);
      await h.service.handleUploadReview(row);
      expect((await h.service.getActionCenter()).summary.filesWaiting).toBe(
        waiting ? 1 : 0,
      );
    },
  );

  it('preserves waiting metadata edits and personal A/B state, invalidates snooze on reopen, and expires snooze', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T00:00:00Z'));
    const h = harness();
    const row = upload();
    h.uploads.push(row);
    await h.service.handleUploadReview(row);
    const id = String(h.notifications[0]._id);
    h.states.push({
      userId: 'A',
      notificationId: id,
      snoozedUntil: new Date('2026-09-10T01:00:00Z'),
      updatedAt: new Date(),
    } as NotificationUserStateDocument);
    row.customerName = 'Edited name';
    await h.service.handleUploadReview(row);
    expect((await h.service.getActionCenter('A')).summary.snoozed).toBe(1);
    expect((await h.service.getActionCenter('B')).summary.attention).toBe(1);
    expect(h.notifications[0].lastInactiveAt).toBeUndefined();
    jest.setSystemTime(new Date('2026-09-10T00:01:00Z'));
    row.stage = UploadStage.PENDING;
    await h.service.handleUploadReview(row);
    jest.setSystemTime(new Date('2026-09-10T00:02:00Z'));
    row.stage = UploadStage.WAITING_DOWNLOAD;
    await h.service.handleUploadReview(row);
    expect(String(h.notifications[0]._id)).toBe(id);
    expect((await h.service.getActionCenter('A')).summary.attention).toBe(1);
    h.states[0].updatedAt = new Date();
    expect((await h.service.getActionCenter('A')).summary.snoozed).toBe(1);
    jest.setSystemTime(new Date('2026-09-10T02:00:00Z'));
    expect((await h.service.getActionCenter('A')).summary.attention).toBe(1);
  });

  it.each([101, 1001])(
    'returns all %i items, exact satang total and bounded batch calls',
    async (count) => {
      const h = harness();
      for (let index = 0; index < count; index++)
        h.orders.push(
          order({ _id: `order-${index}`, workflowStatus: 'delivered' }),
        );
      const started = performance.now();
      const result = await h.service.getActionCenter();
      const elapsed = performance.now() - started;
      expect(result.items).toHaveLength(count);
      expect(result.summary.outstandingAmount).toBe(count / 10);
      expect(h.orderFind).toHaveBeenCalledTimes(1);
      expect(h.uploadFind).toHaveBeenCalledTimes(1);
      expect(h.bulkWrite).toHaveBeenCalledTimes(1);
      h.bulkWrite.mockClear();
      await h.service.getActionCenter();
      expect(h.bulkWrite).not.toHaveBeenCalled();
      if (count === 1001)
        console.info(
          `Action Center fixture: ${count} rows in ${elapsed.toFixed(1)}ms; mocked DB, not a production benchmark`,
        );
    },
  );
});
