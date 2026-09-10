import { createConnection, type Connection, type Model, Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { NotificationsService } from './notifications.service';
import {
  Notification,
  NotificationSchema,
  type NotificationDocument,
} from './notifications.schema';
import {
  NotificationUserState,
  NotificationUserStateSchema,
  type NotificationUserStateDocument,
} from './notification-user-state.schema';
import {
  Order,
  OrderSchema,
  type OrderDocument,
} from '../orders/orders.schema';
import { Upload, UploadSchema } from '../uploads/schemas/upload.schema';
import type { StockItemDocument } from '../inventory/schemas/stock-item.schema';
import { UploadStage, UploadStatus } from '../uploads/uploads.enums';

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(120_000);

describeMongo(
  'Action Center against isolated MongoDB (no production connection)',
  () => {
    let mongo: MongoMemoryServer;
    let connection: Connection;
    let notifications: Model<NotificationDocument>;
    let orders: Model<OrderDocument>;
    let uploads: Model<Upload>;
    let states: Model<NotificationUserStateDocument>;
    let service: NotificationsService;

    beforeAll(async () => {
      mongo = await MongoMemoryServer.create();
      connection = createConnection(mongo.getUri(), {
        dbName: 'action-center-redesign-test',
      });
      await connection.asPromise();
      notifications = connection.model<NotificationDocument>(
        Notification.name,
        NotificationSchema,
      );
      orders = connection.model<OrderDocument>(Order.name, OrderSchema);
      uploads = connection.model<Upload>(Upload.name, UploadSchema);
      states = connection.model<NotificationUserStateDocument>(
        NotificationUserState.name,
        NotificationUserStateSchema,
      );
      await Promise.all([
        notifications.init(),
        orders.init(),
        uploads.init(),
        states.init(),
      ]);
      service = new NotificationsService(
        notifications,
        orders,
        {} as Model<StockItemDocument>,
        undefined,
        states,
        uploads,
      );
      jest.spyOn(service, 'syncLowStockNotifications').mockResolvedValue();
      jest
        .spyOn(service, 'syncOverdueProductionNotifications')
        .mockResolvedValue();
    });
    afterAll(async () => {
      await connection?.close();
      await mongo?.stop();
    });

    it('repairs 1001 records, persists independent state, reuses keys and resolves from real source queries', async () => {
      const ids = Array.from({ length: 1000 }, () => new Types.ObjectId());
      // Minimal persisted legacy facts deliberately bypass document defaults/validation.
      await orders.collection.insertMany(
        ids.map((_id, index) => ({
          _id,
          orderNumber: 'BENCH-' + index,
          customerName: 'Synthetic fixture',
          status: 'partial',
          workflowStatus: 'delivered',
          remainingTotal: 0.1,
        })),
      );
      await uploads.collection.insertOne({
        uploadId: 'mongo-upload',
        orderCode: 'UPLOAD-ONLY',
        status: UploadStatus.PENDING,
        files: [],
        customerName: 'Synthetic fixture',
      });
      const started = performance.now();
      const snapshot = await service.getActionCenter('A');
      const elapsed = performance.now() - started;
      expect(snapshot.items).toHaveLength(1001);
      expect(snapshot.summary.outstandingAmount).toBe(100);
      const payment = snapshot.items.find(
        (item) => item.type === 'payment_outstanding',
      )!;
      const review = snapshot.items.find(
        (item) => item.type === 'upload_review_required',
      )!;
      await service.updateActionCenterUserState('A', {
        notificationIds: [payment._id],
        action: 'acknowledge',
      });
      expect((await service.getActionCenter('A')).summary.acknowledged).toBe(1);
      expect((await service.getActionCenter('B')).summary.acknowledged).toBe(0);
      await orders.collection.updateOne(
        { _id: new Types.ObjectId(payment.orderId) },
        { $set: { remainingTotal: 0.3 } },
      );
      expect(
        (await service.getActionCenter('A')).summary.outstandingAmount,
      ).toBe(100.2);
      await uploads.collection.updateOne(
        { uploadId: 'mongo-upload' },
        { $set: { stage: UploadStage.PENDING } },
      );
      expect((await service.getActionCenter('A')).summary.filesWaiting).toBe(0);
      await uploads.collection.updateOne(
        { uploadId: 'mongo-upload' },
        { $set: { stage: UploadStage.WAITING_DOWNLOAD } },
      );
      const reopened = await service.getActionCenter('A');
      expect(
        reopened.items.find((item) => item.type === 'upload_review_required')
          ?._id,
      ).toBe(review._id);
      await orders.collection.updateOne(
        { _id: new Types.ObjectId(payment.orderId) },
        { $set: { status: 'cancelled' } },
      );
      const cancelled = await service.getActionCenter('A');
      expect(cancelled.items).toHaveLength(1000);
      expect(cancelled.items.some((item) => item._id === payment._id)).toBe(
        false,
      );
      expect(await notifications.countDocuments()).toBe(1001);
      console.info(
        `Isolated MongoDB snapshot: 1001 rows, ${elapsed.toFixed(1)}ms, ${Buffer.byteLength(JSON.stringify(snapshot))} bytes; not a production benchmark`,
      );
    });
  },
);
