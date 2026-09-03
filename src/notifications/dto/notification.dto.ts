import { Transform, Type } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_STATUSES,
} from '../notifications.schema';
import type {
  NotificationCategory,
  NotificationPriority,
  NotificationStatus,
  NotificationType,
} from '../notifications.schema';

export class NotificationResponseDto {
  _id!: string;

  type!: NotificationType;

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

  entityType?: 'order' | 'upload' | 'payment' | 'stock' | 'production_job';

  entityId?: string;

  action?: {
    label: string;
    href?: string;
    action?: string;
  };

  attentionState?: 'new' | 'acknowledged' | 'snoozed';

  acknowledgedAt?: Date;

  snoozedUntil?: Date;

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
  @Transform(({ value }: TransformFnParams): unknown => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value as unknown;
  })
  @IsBoolean()
  isRead?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 50;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number = 0;
}

export class ActiveNotificationsQueryDto {
  @IsOptional()
  @IsEnum(NOTIFICATION_CATEGORIES)
  category?: NotificationCategory;
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

export class ActionCenterSummaryDto {
  total!: number;

  attention!: number;

  acknowledged!: number;

  snoozed!: number;

  critical!: number;

  outstandingAmount!: number;

  filesWaiting!: number;
}

export class ActionCenterDto {
  summary!: ActionCenterSummaryDto;

  items!: NotificationResponseDto[];
}

export class MarkNotificationReadDto {
  @IsBoolean()
  isRead!: boolean;
}

export const ACTION_CENTER_USER_ACTIONS = [
  'acknowledge',
  'unacknowledge',
  'snooze',
  'dismiss',
] as const;
export type ActionCenterUserAction =
  (typeof ACTION_CENTER_USER_ACTIONS)[number];

export class UpdateActionCenterUserStateDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  notificationIds!: string[];

  @IsEnum(ACTION_CENTER_USER_ACTIONS)
  action!: ActionCenterUserAction;

  @ValidateIf(
    (value: UpdateActionCenterUserStateDto) => value.action === 'snooze',
  )
  @Type(() => Number)
  @IsInt()
  @Min(15)
  @Max(1440)
  snoozeMinutes?: number;
}

export class ActionCenterUserStateResultDto {
  updated!: number;
}
