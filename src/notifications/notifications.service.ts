import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
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
} from './dto/notification.dto';
import { Order, ORDER_WORKFLOW_STATUSES } from '../orders/orders.schema';
import type {
  OrderDocument,
  OrderWorkflowStatus,
} from '../orders/orders.schema';
import type { UploadDocument } from '../uploads/schemas/upload.schema';
import { StockItem } from '../inventory/schemas/stock-item.schema';
import type { StockItemDocument } from '../inventory/schemas/stock-item.schema';
import {
  ProductionJob,
  ProductionJobDocument,
} from '../production/schemas/production-job.schema';
import { incompleteProductionJobMatch } from '../production/production-urgency';

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
      const saved = await this.notificationModel.findOneAndUpdate(
        { notificationKey },
        {
          $set: values,
          $setOnInsert: { notificationKey },
          $unset: { resolvedAt: 1, dismissedAt: 1 },
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
    if (notification.category === 'action_required') {
      throw new BadRequestException(
        'Action-required items resolve from the underlying business state.',
      );
    }

    notification.status = 'resolved';
    notification.resolvedAt = new Date();
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
    if (notification.category === 'action_required') {
      throw new BadRequestException(
        'Action-required items cannot be dismissed while the condition is active.',
      );
    }

    notification.status = 'dismissed';
    notification.dismissedAt = new Date();
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
        $set: { status: 'resolved', resolvedAt: new Date() },
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
        $set: { status: 'resolved', resolvedAt: new Date() },
      },
    );
  }

  /**
   * Return the operational action queue and summary from one consistent snapshot.
   * Legacy order-created noise is intentionally excluded from this view.
   */
  async getActionCenter(): Promise<ActionCenterDto> {
    await Promise.all([
      this.syncLowStockNotifications(),
      this.syncOverdueProductionNotifications(),
    ]);

    const notifications = await this.notificationModel
      .find({ status: 'active', type: { $in: ACTION_CENTER_TYPES } })
      .sort({ createdAt: -1 })
      .exec();

    const priorityOrder: Record<NotificationPriority, number> = {
      critical: 0,
      high: 1,
      normal: 2,
      low: 3,
    };
    const items = notifications
      .map((notification) => this.toResponseDto(notification))
      .sort((a, b) => {
        const priorityDiff =
          priorityOrder[a.priority] - priorityOrder[b.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return b.createdAt.getTime() - a.createdAt.getTime();
      });

    return {
      summary: {
        total: items.length,
        critical: items.filter((item) => item.priority === 'critical').length,
        outstandingAmount: items
          .filter((item) => item.type === 'payment_outstanding')
          .reduce((sum, item) => sum + (item.amount ?? 0), 0),
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
    if (order.remainingTotal <= 0) {
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

    if (this.resolveEffectiveWorkflowStatus(order) === 'delivered') {
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

    const orderId = String(order._id);

    // Payment outstanding notification
    if (order.remainingTotal > 0) {
      const key = `payment_outstanding:${orderId}`;
      await this.createNotification({
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
      });
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
        const key = `order_ready:${orderId}`;
        await this.createNotification({
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
        });
        break;
      }

      case 'delivered': {
        await this.autoResolvePickupNotifications(orderId);
        break;
      }
    }
  }

  /**
   * Check and create upload-related notifications
   */
  async handleUploadReview(upload: UploadDocument): Promise<void> {
    const uploadId = upload.uploadId;
    const orderId = upload.orderCode;

    const key = `upload_review:${uploadId}`;
    await this.createNotification({
      type: 'upload_review_required',
      category: 'action_required',
      priority: 'high',
      title: `ไฟล์ใหม่รอตรวจสอบ`,
      message: `${upload.files?.length || 1} ไฟล์ที่ต้องการตรวจสอบ`,
      orderId,
      relatedUploadId: uploadId,
      entityType: 'upload',
      entityId: uploadId,
      notificationKey: key,
      action: {
        label: 'ตรวจไฟล์',
        action: 'review_upload',
      },
    });
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

  private resolveEffectiveWorkflowStatus(
    order: OrderDocument,
  ): OrderWorkflowStatus | null {
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
