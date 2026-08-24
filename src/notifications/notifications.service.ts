import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Notification,
  NotificationDocument,
  NotificationStatus,
  NotificationCategory,
  NotificationPriority,
  NotificationType,
} from './notifications.schema';
import {
  NotificationResponseDto,
  ListNotificationsQueryDto,
  NotificationCountDto,
} from './dto/notification.dto';
import { Order, OrderDocument, OrderStatus } from '../orders/orders.schema';
import { Upload, UploadDocument } from '../uploads/schemas/upload.schema';

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

@Injectable()
export class NotificationsService {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<NotificationDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Upload.name)
    private readonly uploadModel: Model<UploadDocument>,
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
    reason?: string,
  ): Promise<NotificationResponseDto> {
    const notification = await this.notificationModel.findById(notificationId);
    if (!notification) {
      throw new NotFoundException(`Notification not found: ${notificationId}`);
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
   * Get active notifications only (those needing action)
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
    const [total, active, actionRequired, byPriority] = await Promise.all([
      this.notificationModel.countDocuments({}),
      this.notificationModel.countDocuments({ status: 'active' }),
      this.notificationModel.countDocuments({
        status: 'active',
        category: 'action_required',
      }),
      Promise.all([
        this.notificationModel.countDocuments({
          status: 'active',
          priority: 'critical',
        }),
        this.notificationModel.countDocuments({
          status: 'active',
          priority: 'high',
        }),
        this.notificationModel.countDocuments({
          status: 'active',
          priority: 'normal',
        }),
        this.notificationModel.countDocuments({
          status: 'active',
          priority: 'low',
        }),
      ]),
    ]);

    return {
      total,
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
            status: 'resolved' as NotificationStatus,
            resolvedAt: new Date(),
          },
        },
      );
    }
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
            status: 'resolved' as NotificationStatus,
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
          href: `/home/orders/${orderId}`,
          action: 'pay',
        },
      });
    }
  }

  /**
   * Check and create status-change notifications
   */
  async handleOrderStatusChange(
    order: OrderDocument,
    previousStatus?: OrderStatus,
  ): Promise<void> {
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
            label: 'ดูงาน',
            href: `/home/orders/${orderId}`,
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
        href: `/home/orders/${orderId}?tab=files`,
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
            href: `/home/orders/${orderId}`,
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
            label: 'ยืนยันรายการ',
            href: `/home/orders/${orderId}`,
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
