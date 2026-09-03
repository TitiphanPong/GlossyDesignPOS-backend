import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NotificationDocument = HydratedDocument<Notification>;

export const NOTIFICATION_TYPES = [
  'order_created',
  'order_status_changed',
  'payment_outstanding',
  'payment_failed',
  'order_overdue',
  'production_overdue',
  'order_ready_for_pickup',
  'order_pickup_delayed',
  'upload_received',
  'upload_review_required',
  'upload_failed',
  'low_stock',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_PRIORITIES = [
  'critical',
  'high',
  'normal',
  'low',
] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_STATUSES = [
  'active',
  'resolved',
  'dismissed',
] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_CATEGORIES = [
  'action_required', // ต้องจัดการ
  'today', // วันนี้
  'follow_up', // ติดตาม
  'system', // ระบบ
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

@Schema({ timestamps: true })
export class Notification {
  @Prop({
    type: String,
    enum: NOTIFICATION_TYPES,
    required: true,
    index: true,
  })
  type!: NotificationType;

  @Prop({
    type: String,
    enum: NOTIFICATION_CATEGORIES,
    required: true,
    index: true,
  })
  category!: NotificationCategory;

  @Prop({
    type: String,
    enum: NOTIFICATION_PRIORITIES,
    default: 'normal',
  })
  priority!: NotificationPriority;

  @Prop({
    type: String,
    enum: NOTIFICATION_STATUSES,
    default: 'active',
    index: true,
  })
  status!: NotificationStatus;

  @Prop({ required: true })
  title!: string;

  @Prop()
  message?: string;

  // Context fields to show in notification
  @Prop()
  orderId?: string;

  @Prop()
  orderCode?: string;

  @Prop()
  customerName?: string;

  @Prop()
  amount?: number;

  @Prop()
  dueDate?: Date;

  @Prop()
  relatedUploadId?: string;

  // Entity reference for deep linking
  @Prop({
    enum: ['order', 'upload', 'payment', 'stock', 'production_job'],
    sparse: true,
  })
  entityType?: 'order' | 'upload' | 'payment' | 'stock' | 'production_job';

  @Prop({ sparse: true })
  entityId?: string;

  // Action to display
  @Prop({
    type: {
      label: { type: String, required: true },
      href: { type: String },
      action: { type: String },
    },
  })
  action?: {
    label: string;
    href?: string;
    action?: string;
  };

  // For deduplication - same notificationKey won't create duplicates
  @Prop({ unique: true, sparse: true, index: true })
  notificationKey?: string;

  // Track if user has seen it
  @Prop({ default: false })
  isRead!: boolean;

  // When notification was resolved
  @Prop()
  resolvedAt?: Date;

  // When notification was dismissed
  @Prop()
  dismissedAt?: Date;

  // Last time this logical condition became inactive. User acknowledgement/snooze
  // state older than this timestamp belongs to a previous occurrence and is ignored.
  @Prop()
  lastInactiveAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

// Index for efficient queries
NotificationSchema.index({ status: 1, category: 1, createdAt: -1 });
NotificationSchema.index({ orderId: 1, status: 1 });
NotificationSchema.index({ entityType: 1, entityId: 1 });
