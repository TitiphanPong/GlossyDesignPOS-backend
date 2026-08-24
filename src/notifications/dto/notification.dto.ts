import { IsOptional, IsEnum, IsBoolean, IsString } from 'class-validator';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_STATUSES,
  NotificationCategory,
  NotificationPriority,
  NotificationStatus,
} from '../notifications.schema';

export class NotificationResponseDto {
  _id!: string;

  type!: string;

  category!: NotificationCategory;

  priority!: NotificationPriority;

  status!: NotificationStatus;

  title!: string;

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

  isRead!: boolean;

  createdAt!: Date;

  updatedAt!: Date;

  resolvedAt?: Date;

  dismissedAt?: Date;
}

export class ListNotificationsQueryDto {
  @IsOptional()
  @IsEnum(NOTIFICATION_STATUSES)
  status?: NotificationStatus;

  @IsOptional()
  @IsEnum(NOTIFICATION_CATEGORIES)
  category?: NotificationCategory;

  @IsOptional()
  @IsBoolean()
  isRead?: boolean;

  @IsOptional()
  limit?: number;

  @IsOptional()
  skip?: number;
}

export class NotificationCountDto {
  total!: number;

  active!: number;

  actionRequired!: number;

  byPriority!: {
    critical: number;
    high: number;
    normal: number;
    low: number;
  };
}

export class ResolveNotificationDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class MarkNotificationReadDto {
  @IsBoolean()
  isRead!: boolean;
}
