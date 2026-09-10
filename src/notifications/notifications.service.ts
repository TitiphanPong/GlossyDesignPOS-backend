import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Notification } from './notifications.schema';
import type {
  NotificationCategory,
  NotificationDocument,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
} from './notifications.schema';
import {
  NotificationResponseDto,
  ListNotificationsQueryDto,
  NotificationCountDto,
  ActionCenterDto,
  UpdateActionCenterUserStateDto,
  ActionCenterUserStateResultDto,
} from './dto/notification.dto';
import { Order, ORDER_WORKFLOW_STATUSES } from '../orders/orders.schema';
import type {
  OrderDocument,
  OrderWorkflowStatus,
} from '../orders/orders.schema';
import { Upload } from '../uploads/schemas/upload.schema';
import { UploadStage, UploadStatus } from '../uploads/uploads.enums';
import { fromMinorUnits, toMinorUnits } from '../orders/order-money';
import { StockItem } from '../inventory/schemas/stock-item.schema';
import type { StockItemDocument } from '../inventory/schemas/stock-item.schema';
import {
  ProductionJob,
  ProductionJobDocument,
} from '../production/schemas/production-job.schema';
import { incompleteProductionJobMatch } from '../production/production-urgency';
import {
  NotificationUserState,
  NotificationUserStateDocument,
} from './notification-user-state.schema';

interface CreateNotificationOptions {
  type: NotificationType;
  category: NotificationCategory;
  priority?: NotificationPriority;
  title: string;
  message?: string;
  orderId?: string;
  orderCode?: string;
  customerName?: string;
  amount?: number;
  dueDate?: Date;
  relatedUploadId?: string;
  entityType?: 'order' | 'upload' | 'payment' | 'stock' | 'production_job';
  entityId?: string;
  action?: {
    label: string;
    href?: string;
    action?: string;
  };
  notificationKey?: string; // For deduplication
}

type OrderStatusNotification = {
  _id: string;
  status: OrderWorkflowStatus;
  orderNumber?: string;
  customerName: string;
};

type OrderFacts = Pick<
  Order,
  | 'status'
  | 'workflowStatus'
  | 'statusHistory'
  | 'remainingTotal'
  | 'orderNumber'
  | 'customerName'
> & { _id: unknown };
type UploadFacts = Pick<
  Upload,
  | 'uploadId'
  | 'status'
  | 'stage'
  | 'customerName'
  | 'displayName'
  | 'linkedOrderId'
  | 'linkedOrderNumber'
> & { files?: Upload['files']; fileCount?: number };

const ACTION_CENTER_TYPES: readonly NotificationType[] = [
  'payment_outstanding',
  'payment_failed',
  'order_ready_for_pickup',
  'order_pickup_delayed',
  'production_overdue',
  'upload_review_required',
  'upload_failed',
  'low_stock',
];

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
    @InjectModel(ProductionJob.name)
    private readonly productionJobModel?: Model<ProductionJobDocument>,
    @Optional()
    @InjectModel(NotificationUserState.name)
    private readonly notificationUserStateModel?: Model<NotificationUserStateDocument>,
    @InjectModel(Upload.name)
    private readonly uploadModel?: Model<Upload>,
  ) {}

  /**
   * Create a notification with automatic deduplication
   */
  async createNotification(
    options: CreateNotificationOptions,
  ): Promise<NotificationResponseDto> {
    const notificationKey = options.notificationKey;
    const values = {
      type: options.type,
      category: options.category,
      priority: options.priority || 'normal',
      title: options.title,
      message: options.message,
      orderId: options.orderId,
      orderCode: options.orderCode,
      customerName: options.customerName,
      amount: options.amount,
      dueDate: options.dueDate,
      relatedUploadId: options.relatedUploadId,
      entityType: options.entityType,
      entityId: options.entityId,
      action: options.action,
      status: 'active' as NotificationStatus,
      isRead: false,
    };

    if (notificationKey) {
      const unset: Record<string, 1> = { resolvedAt: 1, dismissedAt: 1 };
      // Mongoose omits undefined $set values; explicitly clear removed upload context.
      if (options.type === 'upload_review_required') {
        for (const field of ['orderId', 'orderCode', 'customerName'] as const) {
          if (values[field] === undefined) unset[field] = 1;
        }
      }
      const saved = await this.notificationModel.findOneAndUpdate(
        { notificationKey },
        {
          $set: values,
          $setOnInsert: { notificationKey },
          $unset: unset,
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      return this.toResponseDto(saved);
    }

    const notification = new this.notificationModel(values);
    const saved = await notification.save();
    return this.toResponseDto(saved);
  }

  /**
   * Resolve notification when condition is met
   */
  async resolveNotification(
    notificationId: string,
  ): Promise<NotificationResponseDto> {
    const notification = await this.notificationModel.findById(notificationId);
    if (!notification) {
      throw new NotFoundException(`Notification not found: ${notificationId}`);
    }
    if (this.isActionCenterNotification(notification.type)) {
      throw new BadRequestException(
        'Operational Action Center items resolve from the underlying business state.',
      );
    }

    const now = new Date();
    notification.status = 'resolved';
    notification.resolvedAt = now;
    notification.lastInactiveAt = now;
    await notification.save();

    return this.toResponseDto(notification);
  }

  /**
   * Dismiss notification (user closes it)
   */
  async dismissNotification(
    notificationId: string,
  ): Promise<NotificationResponseDto> {
    const notification = await this.notificationModel.findById(notificationId);
    if (!notification) {
      throw new NotFoundException(`Notification not found: ${notificationId}`);
    }
    if (this.isActionCenterNotification(notification.type)) {
      throw new BadRequestException(
        'Operational Action Center items cannot be dismissed while the condition is active.',
      );
    }

    const now = new Date();
    notification.status = 'dismissed';
    notification.dismissedAt = now;
    notification.lastInactiveAt = now;
    await notification.save();

    return this.toResponseDto(notification);
  }

  /**
   * Mark notification as read
   */
  async markAsRead(
    notificationId: string,
    isRead: boolean,
  ): Promise<NotificationResponseDto> {
    const notification = await this.notificationModel.findByIdAndUpdate(
      notificationId,
      { isRead },
      { new: true },
    );

    if (!notification) {
      throw new NotFoundException(`Notification not found: ${notificationId}`);
    }

    return this.toResponseDto(notification);
  }

  /**
   * Update only one staff user's visibility state for Action Center items.
   * This never mutates the underlying operational notification status.
   */
  async updateActionCenterUserState(
    userId: string,
    input: UpdateActionCenterUserStateDto,
  ): Promise<ActionCenterUserStateResultDto> {
    if (!this.notificationUserStateModel) {
      throw new BadRequestException('Action Center user state is unavailable.');
    }

    const notificationIds = [
      ...new Set(input.notificationIds.map((id) => id.trim())),
    ].filter(Boolean);
    if (notificationIds.length === 0) {
      throw new BadRequestException(
        'At least one notification id is required.',
      );
    }

    const notifications = await this.notificationModel
      .find({ _id: { $in: notificationIds } })
      .exec();
    if (notifications.length !== notificationIds.length) {
      throw new NotFoundException('One or more notifications were not found.');
    }

    if (input.action === 'dismiss') {
      if (
        notifications.some(
          (item) =>
            item.status === 'active' &&
            this.isActionCenterNotification(item.type),
        )
      ) {
        throw new BadRequestException(
          'Operational Action Center items cannot be dismissed while their business condition is active.',
        );
      }
    } else if (
      notifications.some(
        (item) =>
          item.status !== 'active' ||
          !this.isActionCenterNotification(item.type),
      )
    ) {
      throw new BadRequestException(
        'Acknowledge and snooze actions apply only to active operational Action Center items.',
      );
    }

    const now = new Date();
    const snoozedUntil =
      input.action === 'snooze'
        ? new Date(now.getTime() + (input.snoozeMinutes ?? 60) * 60_000)
        : undefined;

    const operations = notificationIds.map((notificationId) => {
      const filter = { userId, notificationId };
      if (input.action === 'unacknowledge') {
        return {
          updateOne: {
            filter,
            update: {
              $set: { updatedAt: now },
              $unset: { acknowledgedAt: 1, snoozedUntil: 1, dismissedAt: 1 },
            },
            upsert: false,
          },
        };
      }

      const setValues: Record<string, Date | string> = {
        userId,
        notificationId,
        updatedAt: now,
      };
      if (input.action === 'acknowledge') setValues.acknowledgedAt = now;
      if (input.action === 'snooze' && snoozedUntil)
        setValues.snoozedUntil = snoozedUntil;
      if (input.action === 'dismiss') setValues.dismissedAt = now;

      return {
        updateOne: {
          filter,
          update: {
            $set: setValues,
            $setOnInsert: { createdAt: now },
            $unset:
              input.action === 'acknowledge'
                ? { snoozedUntil: 1, dismissedAt: 1 }
                : input.action === 'snooze'
                  ? { acknowledgedAt: 1, dismissedAt: 1 }
                  : { acknowledgedAt: 1, snoozedUntil: 1 },
          },
          upsert: true,
        },
      };
    });

    await this.notificationUserStateModel.bulkWrite(operations);
    return { updated: notificationIds.length };
  }

  /**
   * List notifications with filters
   */
  async listNotifications(query: ListNotificationsQueryDto = {}): Promise<{
    data: NotificationResponseDto[];
    total: number;
    skip: number;
    limit: number;
  }> {
    const skip = query.skip || 0;
    const limit = Math.min(query.limit || 50, 100);

    const filter: Record<string, unknown> = {};

    if (query.status) {
      filter.status = query.status;
    }

    if (query.category) {
      filter.category = query.category;
    }

    if (query.isRead !== undefined) {
      filter.isRead = query.isRead;
    }

    const [data, total] = await Promise.all([
      this.notificationModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.notificationModel.countDocuments(filter),
    ]);

    return {
      data: data.map((n) => this.toResponseDto(n)),
      total,
      skip,
      limit,
    };
  }

  async syncLowStockNotifications(): Promise<void> {
    const lowStockItems = await this.stockItemModel
      .find({
        active: { $ne: false },
        $expr: { $lte: ['$onHand', '$minimumLevel'] },
      })
      .exec();

    const activeKeys: string[] = [];
    for (const item of lowStockItems) {
      const itemId = String(item._id);
      const key = `low_stock:${itemId}`;
      activeKeys.push(key);
      await this.createNotification({
        type: 'low_stock',
        category: 'action_required',
        priority: 'high',
        title: `สต็อกต่ำ ${item.name}`,
        message: `คงเหลือ ${item.onHand} ${item.unit} · ขั้นต่ำ ${item.minimumLevel} ${item.unit}`,
        entityType: 'stock',
        entityId: itemId,
        notificationKey: key,
        action: {
          label: 'เปิดสต็อก',
          action: 'open_stock',
        },
      });
    }

    await this.notificationModel.updateMany(
      {
        type: 'low_stock',
        status: 'active',
        ...(activeKeys.length ? { notificationKey: { $nin: activeKeys } } : {}),
      },
      {
        $set: {
          status: 'resolved',
          resolvedAt: new Date(),
          lastInactiveAt: new Date(),
        },
      },
    );
  }

  async syncOverdueProductionNotifications(): Promise<void> {
    if (!this.productionJobModel) return;
    const overdueJobs = await this.productionJobModel
      .find({
        ...incompleteProductionJobMatch(),
        dueAt: { $lt: new Date() },
      })
      .select('jobNumber orderId orderNumber workSummary dueAt')
      .exec();

    const activeKeys: string[] = [];
    for (const job of overdueJobs) {
      const jobId = String(job._id);
      const key = `production_overdue:${jobId}`;
      activeKeys.push(key);
      await this.createNotification({
        type: 'production_overdue',
        category: 'action_required',
        priority: 'high',
        title: `งานผลิตเกินกำหนด ${job.jobNumber}`,
        message: job.workSummary,
        orderId: String(job.orderId),
        orderCode: job.orderNumber,
        dueDate: job.dueAt,
        entityType: 'production_job',
        entityId: jobId,
        notificationKey: key,
        action: {
          label: 'เปิด Production Board',
          action: 'open_production_job',
        },
      });
    }

    await this.notificationModel.updateMany(
      {
        type: 'production_overdue',
        status: 'active',
        ...(activeKeys.length ? { notificationKey: { $nin: activeKeys } } : {}),
      },
      {
        $set: {
          status: 'resolved',
          resolvedAt: new Date(),
          lastInactiveAt: new Date(),
        },
      },
    );
  }

  /**
   * Return the operational action queue and summary from one consistent snapshot.
   * Legacy order-created noise is intentionally excluded from this view.
   */
  async getActionCenter(userId?: string): Promise<ActionCenterDto> {
    await Promise.all([
      this.syncLowStockNotifications(),
      this.syncOverdueProductionNotifications(),
      this.syncOrderAndUploadNotifications(),
    ]);

    const notifications = await this.notificationModel
      .find({ status: 'active', type: { $in: ACTION_CENTER_TYPES } })
      .sort({ createdAt: -1 })
      .exec();

    const notificationIds = notifications.map((notification) =>
      String(notification._id),
    );
    const userStates =
      userId && this.notificationUserStateModel && notificationIds.length > 0
        ? await this.notificationUserStateModel
            .find({ userId, notificationId: { $in: notificationIds } })
            .exec()
        : [];
    const stateByNotificationId = new Map(
      userStates.map((state) => [state.notificationId, state] as const),
    );
    const now = new Date();

    const priorityOrder: Record<NotificationPriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };
    const items = notifications
      .map((notification) => {
        const state = stateByNotificationId.get(String(notification._id));
        const stateIsCurrent =
          Boolean(state) &&
          (!notification.lastInactiveAt ||
            Boolean(
              state?.updatedAt && state.updatedAt > notification.lastInactiveAt,
            ));
        const attentionState = !stateIsCurrent
          ? ('new' as const)
          : state?.snoozedUntil && state.snoozedUntil > now
            ? ('snoozed' as const)
            : state?.acknowledgedAt
              ? ('acknowledged' as const)
              : ('new' as const);

        return {
          ...this.toResponseDto(notification),
          attentionState,
          ...(stateIsCurrent && state?.acknowledgedAt
            ? { acknowledgedAt: state.acknowledgedAt }
            : {}),
          ...(stateIsCurrent && state?.snoozedUntil
            ? { snoozedUntil: state.snoozedUntil }
            : {}),
        };
      })
      .sort((a, b) => {
        const priorityDiff =
          priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return (
          b.createdAt.getTime() - a.createdAt.getTime() ||
          a._id.localeCompare(b._id)
        );
      });

    return {
      summary: {
        total: items.length,
        attention: items.filter((item) => item.attentionState === 'new').length,
        acknowledged: items.filter(
          (item) => item.attentionState === 'acknowledged',
        ).length,
        snoozed: items.filter((item) => item.attentionState === 'snoozed')
          .length,
        critical: items.filter((item) => item.priority === 'critical').length,
        outstandingAmount: fromMinorUnits(
          items
            .filter((item) => item.type === 'payment_outstanding')
            .reduce(
              (sum, item) =>
                sum + toMinorUnits(item.amount ?? 0, 'outstandingAmount'),
              0,
            ),
        ),
        filesWaiting: items.filter(
          (item) => item.type === 'upload_review_required',
        ).length,
      },
      items,
    };
  }

  /**
   * Get active notifications only (legacy compatibility endpoint).
   */
  async getActiveNotifications(
    category?: NotificationCategory,
  ): Promise<NotificationResponseDto[]> {
    const filter: Record<string, unknown> = { status: 'active' };

    if (category) {
      filter.category = category;
    }

    const notifications = await this.notificationModel
      .find(filter)
      .sort({ priority: -1, createdAt: -1 })
      .exec();

    return notifications.map((n) => this.toResponseDto(n));
  }

  /**
   * Get notification count badge
   */
  async getNotificationCount(): Promise<NotificationCountDto> {
    const scope = { status: 'active', type: { $in: ACTION_CENTER_TYPES } };
    const [active, actionRequired, byPriority] = await Promise.all([
      this.notificationModel.countDocuments(scope),
      this.notificationModel.countDocuments({
        ...scope,
        category: 'action_required',
      }),
      Promise.all([
        this.notificationModel.countDocuments({
          ...scope,
          priority: 'critical',
        }),
        this.notificationModel.countDocuments({ ...scope, priority: 'high' }),
        this.notificationModel.countDocuments({ ...scope, priority: 'normal' }),
        this.notificationModel.countDocuments({ ...scope, priority: 'low' }),
      ]),
    ]);

    return {
      total: active,
      active,
      actionRequired,
      byPriority: {
        critical: byPriority[0],
        high: byPriority[1],
        normal: byPriority[2],
        low: byPriority[3],
      },
    };
  }

  /**
   * Auto-resolve payment notifications when payment is cleared
   */
  async autoResolvePaymentNotifications(orderId: string): Promise<void> {
    const order = await this.orderModel.findById(orderId);
    if (!order) return;

    // If payment is fully received
    if (
      order.remainingTotal <= 0 ||
      this.resolveEffectiveWorkflowStatus(order) === 'cancelled'
    ) {
      await this.notificationModel.updateMany(
        {
          orderId,
          type: { $in: ['payment_outstanding', 'payment_failed'] },
          status: 'active',
        },
        {
          $set: {
            status: 'resolved',
            resolvedAt: new Date(),
            lastInactiveAt: new Date(),
          },
        },
      );
    }
  }

  async autoResolveUploadNotifications(uploadId: string): Promise<void> {
    await this.notificationModel.updateMany(
      {
        relatedUploadId: uploadId,
        type: { $in: ['upload_review_required', 'upload_failed'] },
        status: 'active',
      },
      {
        $set: {
          status: 'resolved',
          resolvedAt: new Date(),
          lastInactiveAt: new Date(),
        },
      },
    );
  }

  /**
   * Auto-resolve order ready notifications from production workflow truth.
   * Financial payment state is intentionally independent from pickup lifecycle.
   */
  async autoResolvePickupNotifications(orderId: string): Promise<void> {
    const order = await this.orderModel.findById(orderId);
    if (!order) return;

    if (
      ['delivered', 'cancelled'].includes(
        this.resolveEffectiveWorkflowStatus(order) ?? '',
      )
    ) {
      await this.notificationModel.updateMany(
        {
          orderId,
          type: { $in: ['order_ready_for_pickup', 'order_pickup_delayed'] },
          status: 'active',
        },
        {
          $set: {
            status: 'resolved',
            resolvedAt: new Date(),
            lastInactiveAt: new Date(),
          },
        },
      );
    }
  }

  /**
   * Clean up old resolved/dismissed notifications
   */
  async cleanupOldNotifications(olderThanDays: number = 30): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

    const result = await this.notificationModel.deleteMany({
      status: { $in: ['resolved', 'dismissed'] },
      updatedAt: { $lt: cutoffDate },
    });

    return result.deletedCount || 0;
  }

  // ============ Notification Rules / Business Logic ============

  /**
   * Check and create payment-related notifications
   */
  async handleOrderPaymentState(order: OrderDocument): Promise<void> {
    if (!order._id) return;

    const options = this.paymentNotification(order);
    if (options) await this.createNotification(options);
    else await this.autoResolvePaymentNotifications(String(order._id));
  }

  private paymentNotification(
    order: OrderFacts,
  ): CreateNotificationOptions | undefined {
    const orderId = String(order._id);

    // Payment outstanding notification
    if (
      order.remainingTotal > 0 &&
      this.resolveEffectiveWorkflowStatus(order) !== 'cancelled'
    ) {
      const key = `payment_outstanding:${orderId}`;
      return {
        type: 'payment_outstanding',
        category: 'action_required',
        priority: 'high',
        title: `ยอดค้าง ${order.customerName || 'ลูกค้า'}`,
        message: `ยอดคงเหลือ ฿${order.remainingTotal.toLocaleString('th-TH')}`,
        orderId,
        orderCode: order.orderNumber,
        customerName: order.customerName,
        amount: order.remainingTotal,
        entityType: 'payment',
        entityId: orderId,
        notificationKey: key,
        action: {
          label: 'รับชำระเงิน',
          action: 'collect_payment',
        },
      };
    }
  }

  /**
   * Check and create status-change notifications
   */
  async handleOrderStatusChange(order: OrderStatusNotification): Promise<void> {
    if (!order._id) return;

    const orderId = String(order._id);

    switch (order.status) {
      case 'ready_for_pickup': {
        await this.createNotification(this.pickupNotification(order));
        break;
      }

      case 'delivered': {
        await this.autoResolvePickupNotifications(orderId);
        break;
      }
      case 'cancelled': {
        await Promise.all([
          this.autoResolvePaymentNotifications(orderId),
          this.autoResolvePickupNotifications(orderId),
        ]);
        break;
      }
    }
  }

  private pickupNotification(
    order: OrderStatusNotification,
  ): CreateNotificationOptions {
    const orderId = String(order._id);
    const key = `order_ready:${orderId}`;
    return {
      type: 'order_ready_for_pickup',
      category: 'follow_up',
      priority: 'normal',
      title: `งานพร้อมรับ #${order.orderNumber}`,
      message: `${order.customerName} สามารถรับงานได้แล้ว`,
      orderId,
      orderCode: order.orderNumber,
      customerName: order.customerName,
      entityType: 'order',
      entityId: orderId,
      notificationKey: key,
      action: {
        label: 'เปิดรายการ',
        action: 'open_order',
      },
    };
  }

  /** Repair missed hooks using persisted facts and stable logical keys. No list cap. */
  async syncOrderAndUploadNotifications(): Promise<void> {
    const scanStartedAt = new Date();
    const types: NotificationType[] = [
      'payment_outstanding',
      'payment_failed',
      'order_ready_for_pickup',
      'order_pickup_delayed',
      'upload_review_required',
      'upload_failed',
    ];
    const projection =
      '_id notificationKey type status updatedAt lastInactiveAt orderId relatedUploadId category priority title message orderCode customerName amount entityType entityId action';
    const active = await this.notificationModel
      .find({ status: 'active', type: { $in: types } })
      .select(projection)
      .lean()
      .exec();
    const orderIds = active
      .map((item) => item.orderId)
      .filter((id): id is string => Boolean(id && Types.ObjectId.isValid(id)));
    const uploadIds = active
      .map((item) => item.relatedUploadId)
      .filter(Boolean);
    const [orders, uploads] = await Promise.all([
      this.orderModel
        .find({
          $or: [
            { _id: { $in: orderIds } },
            {
              status: { $ne: 'cancelled' },
              $or: [
                { remainingTotal: { $gt: 0 } },
                { workflowStatus: 'ready_for_pickup' },
                {
                  workflowStatus: { $nin: ORDER_WORKFLOW_STATUSES },
                  $or: [
                    { status: 'ready_for_pickup' },
                    { 'statusHistory.status': 'ready_for_pickup' },
                  ],
                },
              ],
            },
          ],
        })
        .select(
          '_id status workflowStatus statusHistory remainingTotal orderNumber customerName',
        )
        .lean()
        .exec(),
      this.uploadModel!.aggregate<UploadFacts>([
        {
          $match: {
            $or: [
              { uploadId: { $in: uploadIds } },
              {
                status: { $ne: UploadStatus.COMPLETED },
                stage: { $nin: [UploadStage.COMPLETED, UploadStage.PENDING] },
              },
            ],
          },
        },
        {
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
        },
      ]).exec(),
    ]);
    const desired = new Map<string, CreateNotificationOptions>();
    const ordersById = new Map(
      orders.map((order) => [String(order._id), order]),
    );
    const uploadsById = new Map(
      uploads.map((upload) => [upload.uploadId, upload]),
    );
    for (const order of orders) {
      const payment = this.paymentNotification(order);
      if (payment) desired.set(payment.notificationKey!, payment);
      if (this.resolveEffectiveWorkflowStatus(order) === 'ready_for_pickup') {
        const pickup = this.pickupNotification({
          _id: String(order._id),
          status: 'ready_for_pickup',
          orderNumber: order.orderNumber,
          customerName: order.customerName,
        });
        desired.set(pickup.notificationKey!, pickup);
      }
    }
    for (const upload of uploads) {
      if (this.isWaitingUpload(upload)) {
        const review = this.uploadNotification(upload);
        desired.set(review.notificationKey!, review);
      }
    }
    const existing = desired.size
      ? await this.notificationModel
          .find({ notificationKey: { $in: [...desired.keys()] } })
          .select(projection)
          .lean()
          .exec()
      : [];
    // Active baselines MUST precede source reads. A hook may update facts between
    // the source scan and the desired-key lookup, even within one millisecond.
    const activeByKey = new Map(
      active.map((item) => [item.notificationKey, item]),
    );
    const byKey = new Map(existing.map((item) => [item.notificationKey, item]));
    for (const [key, item] of activeByKey) byKey.set(key, item);
    const observedFilter = (item: (typeof active)[number]) => ({
      // Compare the observed facts too: distinct writes can share a millisecond.
      ...Object.fromEntries(
        projection
          .split(' ')
          .filter((key) => key !== '_id')
          .map((key) => {
            const value = (item as Record<string, unknown>)[key];
            return [
              key,
              value === undefined ? { $exists: false } : { $eq: value },
            ];
          }),
      ),
      _id: item._id,
      status: item.status,
      updatedAt: item.updatedAt ?? { $exists: false },
      $or: [
        { updatedAt: { $lte: scanStartedAt } },
        { updatedAt: { $exists: false } },
      ],
    });
    const operations: Parameters<Model<NotificationDocument>['bulkWrite']>[0] =
      [];
    const now = new Date();
    for (const [notificationKey, options] of desired) {
      const previous = byKey.get(notificationKey);
      if (previous && !activeByKey.has(notificationKey)) {
        // A newly active key belongs to a concurrent hook. For inactive keys a
        // same-ms timestamp is ambiguous: defer repair until the next snapshot.
        if (
          previous.status === 'active' ||
          (previous.updatedAt && previous.updatedAt >= scanStartedAt)
        )
          continue;
      }
      if (previous?.updatedAt && previous.updatedAt > scanStartedAt) continue;
      const values = { ...options, status: 'active' };
      if (
        previous?.status === 'active' &&
        Object.entries(values).every(([key, value]) => {
          if (key === 'action')
            return (
              previous.action?.label === options.action?.label &&
              previous.action?.action === options.action?.action &&
              previous.action?.href === options.action?.href
            );
          return (
            JSON.stringify((previous as Record<string, unknown>)[key]) ===
            JSON.stringify(value)
          );
        })
      )
        continue;
      const set: Record<string, unknown> = {};
      const unset: Record<string, 1> = { resolvedAt: 1, dismissedAt: 1 };
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) unset[key] = 1;
        else set[key] = value;
      }
      operations.push({
        updateOne: {
          filter: previous ? observedFilter(previous) : { notificationKey },
          update: previous
            ? { $set: set, $unset: unset }
            : {
                $setOnInsert: {
                  ...set,
                  isRead: false,
                  createdAt: now,
                  updatedAt: now,
                },
              },
          upsert: !previous,
          // An insert race must leave an existing condition entirely untouched.
          timestamps: Boolean(previous),
        },
      });
    }
    for (const item of active) {
      if (item.status !== 'active' || desired.has(item.notificationKey ?? ''))
        continue;
      let inactive = [
        'payment_outstanding',
        'order_ready_for_pickup',
        'upload_review_required',
      ].includes(item.type);
      const order = ordersById.get(item.orderId ?? '');
      if (item.type === 'payment_failed' && order) {
        inactive =
          order.remainingTotal <= 0 ||
          this.resolveEffectiveWorkflowStatus(order) === 'cancelled';
      }
      if (item.type === 'order_pickup_delayed' && order) {
        inactive = ['delivered', 'cancelled'].includes(
          this.resolveEffectiveWorkflowStatus(order) ?? '',
        );
      }
      const upload = uploadsById.get(item.relatedUploadId ?? '');
      if (item.type === 'upload_failed' && upload)
        inactive = !this.isWaitingUpload(upload);
      if (inactive)
        operations.push({
          updateOne: {
            filter: observedFilter(item),
            update: {
              $set: {
                status: 'resolved',
                resolvedAt: now,
                lastInactiveAt: now,
              },
            },
          },
        });
    }
    if (operations.length) {
      try {
        await this.notificationModel.bulkWrite(operations, { ordered: false });
      } catch (error: unknown) {
        // Concurrent unique-key inserts are safe: the next snapshot repairs any remaining delta.
        const failure = error as {
          writeErrors?: { code: number }[];
          writeConcernErrors?: unknown[];
          result?: { getWriteConcernError?: () => unknown };
        };
        if (
          !failure.writeErrors?.length ||
          failure.writeErrors.some((entry) => entry.code !== 11000) ||
          failure.writeConcernErrors?.length ||
          failure.result?.getWriteConcernError?.()
        )
          throw error;
      }
    }
  }

  /**
   * Check and create upload-related notifications
   */
  async handleUploadReview(upload: Upload): Promise<void> {
    if (!this.isWaitingUpload(upload)) {
      await this.autoResolveUploadNotifications(upload.uploadId);
      return;
    }
    await this.createNotification(this.uploadNotification(upload));
  }

  private isWaitingUpload(upload: UploadFacts): boolean {
    return (
      upload.status !== UploadStatus.COMPLETED &&
      upload.stage !== UploadStage.COMPLETED &&
      upload.stage !== UploadStage.PENDING
    );
  }

  private uploadNotification(upload: UploadFacts): CreateNotificationOptions {
    const uploadId = upload.uploadId;
    const orderId = upload.linkedOrderId || undefined;

    const key = `upload_review:${uploadId}`;
    return {
      type: 'upload_review_required',
      category: 'action_required',
      priority: 'high',
      title: `ไฟล์ใหม่รอตรวจสอบ`,
      message: `${upload.fileCount || upload.files?.length || 1} ไฟล์ที่ต้องการตรวจสอบ`,
      orderId,
      orderCode: upload.linkedOrderNumber || undefined,
      customerName: upload.customerName || upload.displayName,
      relatedUploadId: uploadId,
      entityType: 'upload',
      entityId: uploadId,
      notificationKey: key,
      action: {
        label: 'ตรวจไฟล์',
        action: 'review_upload',
      },
    };
  }

  /**
   * @deprecated Deferred until Production Jobs define a real dueAt/SLA model.
   * The previous createdAt-based 30-minute heuristic must not create Action Center state.
   */
  async checkAndNotifyOverdueOrders(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * @deprecated Deferred until an explicit confirmation/due-date workflow exists.
   * The previous createdAt-based one-hour heuristic must not create Action Center state.
   */
  async checkAndNotifyUnconfirmedOrders(): Promise<void> {
    return Promise.resolve();
  }

  private isActionCenterNotification(type: NotificationType): boolean {
    return ACTION_CENTER_TYPES.includes(type);
  }

  private resolveEffectiveWorkflowStatus(
    order: OrderFacts,
  ): OrderWorkflowStatus | null {
    if (order.status === 'cancelled') return 'cancelled';
    const workflowStatuses = new Set<OrderWorkflowStatus>(
      ORDER_WORKFLOW_STATUSES,
    );

    if (order.workflowStatus && workflowStatuses.has(order.workflowStatus)) {
      return order.workflowStatus;
    }

    const statusHistory = order.statusHistory ?? [];
    for (let index = statusHistory.length - 1; index >= 0; index -= 1) {
      const historicalStatus = statusHistory[index]?.status;
      if (
        historicalStatus &&
        workflowStatuses.has(historicalStatus as OrderWorkflowStatus)
      ) {
        return historicalStatus as OrderWorkflowStatus;
      }
    }

    return workflowStatuses.has(order.status as OrderWorkflowStatus)
      ? (order.status as OrderWorkflowStatus)
      : null;
  }

  private toResponseDto(
    notification: NotificationDocument,
  ): NotificationResponseDto {
    return {
      _id: String(notification._id),
      type: notification.type,
      category: notification.category,
      priority: notification.priority,
      status: notification.status,
      title: notification.title,
      message: notification.message,
      orderId: notification.orderId,
      orderCode: notification.orderCode,
      customerName: notification.customerName,
      amount: notification.amount,
      dueDate: notification.dueDate,
      relatedUploadId: notification.relatedUploadId,
      entityType: notification.entityType,
      entityId: notification.entityId,
      action: notification.action,
      isRead: notification.isRead,
      createdAt: notification.createdAt || new Date(),
      updatedAt: notification.updatedAt || new Date(),
      resolvedAt: notification.resolvedAt,
      dismissedAt: notification.dismissedAt,
    };
  }
}
