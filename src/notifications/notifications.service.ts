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
import { Order } from '../orders/orders.schema';
import type { OrderDocument, OrderStatus } from '../orders/orders.schema';
import type { UploadDocument } from '../uploads/schemas/upload.schema';

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
  entityType?: 'order' | 'upload' | 'payment';
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
  status: OrderStatus;
  orderNumber?: string;
  customerName: string;
};

const ACTION_CENTER_TYPES: readonly NotificationType[] = [
  'payment_outstanding',
  'payment_failed',
  'order_overdue',
  'order_ready_for_pickup',
  'order_pickup_delayed',
  'upload_review_required',
  'upload_failed',
];

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
  ) {}

  /**
   * Create a notification with automatic deduplication
   */
  async createNotification(
    options: CreateNotificationOptions,
  ): Promise<NotificationResponseDto> {
    const notificationKey = options.notificationKey;

    // Check for existing active notification with same key
    if (notificationKey) {
      const existing = await this.notificationModel.findOne({
        notificationKey,
        status: 'active',
      });

      if (existing) {
        // Update timestamp instead of creating duplicate
        existing.updatedAt = new Date();
        await existing.save();
        return this.toResponseDto(existing);
      }
    }

    // Create new notification
    const notification = new this.notificationModel({
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
      notificationKey,
      status: 'active' as NotificationStatus,
    });

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

  /**
   * Return the operational action queue and summary from one consistent snapshot.
   * Legacy order-created noise is intentionally excluded from this view.
   */
  async getActionCenter(): Promise<ActionCenterDto> {
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
   * Auto-resolve order ready notifications when picked up
   */
  async autoResolvePickupNotifications(orderId: string): Promise<void> {
    const order = await this.orderModel.findById(orderId);
    if (!order) return;

    // If order status is delivered/completed
    if (['delivered', 'paid'].includes(order.status)) {
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

      case 'delivered':
      case 'paid': {
        // Auto-resolve pickup notifications
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
   * Check for overdue orders
   */
  async checkAndNotifyOverdueOrders(): Promise<void> {
    // This would typically be called by a scheduled task
    // For now, we check orders that are in production but have old creation date
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    const overdueOrders = await this.orderModel.find({
      status: { $in: ['pending', 'producing'] },
      createdAt: { $lt: thirtyMinutesAgo },
    });

    for (const order of overdueOrders) {
      const orderId = String(order._id);
      const key = `order_overdue:${orderId}`;

      // Check if notification already exists
      const existing = await this.notificationModel.findOne({
        notificationKey: key,
        status: 'active',
      });

      if (!existing) {
        await this.createNotification({
          type: 'order_overdue',
          category: 'action_required',
          priority: 'critical',
          title: `งาน #${order.orderNumber} ล่าช้า`,
          message: `${order.customerName} - ${order.cart[0]?.name}`,
          orderId,
          orderCode: order.orderNumber,
          customerName: order.customerName,
          entityType: 'order',
          entityId: orderId,
          notificationKey: key,
          action: {
            label: 'อัปเดตสถานะ',
            action: 'open_order',
          },
        });
      }
    }
  }

  /**
   * Check for unconfirmed orders
   */
  async checkAndNotifyUnconfirmedOrders(): Promise<void> {
    // Orders waiting for confirmation
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const unconfirmed = await this.orderModel.find({
      status: 'pending',
      createdAt: { $lt: oneHourAgo },
    });

    for (const order of unconfirmed) {
      const orderId = String(order._id);
      const key = `order_pending_confirm:${orderId}`;

      const existing = await this.notificationModel.findOne({
        notificationKey: key,
        status: 'active',
      });

      if (!existing) {
        await this.createNotification({
          type: 'order_created',
          category: 'action_required',
          priority: 'high',
          title: `รายการขายใหม่ #${order.orderNumber}`,
          message: `${order.customerName} รอการยืนยัน`,
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
      }
    }
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
