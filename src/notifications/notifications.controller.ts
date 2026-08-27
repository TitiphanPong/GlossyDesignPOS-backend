import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  Delete,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import {
  NotificationResponseDto,
  ListNotificationsQueryDto,
  NotificationCountDto,
  MarkNotificationReadDto,
  ActiveNotificationsQueryDto,
  ActionCenterDto,
} from './dto/notification.dto';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Get the cashier action center in one consistent snapshot.
   * GET /notifications/action-center
   */
  @Get('action-center')
  async getActionCenter(): Promise<ActionCenterDto> {
    return this.notificationsService.getActionCenter();
  }

  /**
   * Get active notifications (legacy compatibility endpoint).
   * GET /notifications/active?category=action_required
   */
  @Get('active')
  async getActive(
    @Query() query: ActiveNotificationsQueryDto,
  ): Promise<NotificationResponseDto[]> {
    return this.notificationsService.getActiveNotifications(query.category);
  }

  /**
   * Get notification count badge
   * GET /notifications/count
   */
  @Get('count')
  async getCount(): Promise<NotificationCountDto> {
    return this.notificationsService.getNotificationCount();
  }

  /**
   * List all notifications with filters
   * GET /notifications?status=active&category=action_required&limit=50&skip=0
   */
  @Get()
  async list(@Query() query: ListNotificationsQueryDto) {
    return this.notificationsService.listNotifications(query);
  }

  /**
   * Mark notification as read/unread
   * PATCH /notifications/:id/read
   */
  @Patch(':id/read')
  async markAsRead(
    @Param('id') id: string,
    @Body() body: MarkNotificationReadDto,
  ): Promise<NotificationResponseDto> {
    return this.notificationsService.markAsRead(id, body.isRead);
  }

  /**
   * Resolve a notification
   * PATCH /notifications/:id/resolve
   */
  @Patch(':id/resolve')
  async resolve(@Param('id') id: string): Promise<NotificationResponseDto> {
    return this.notificationsService.resolveNotification(id);
  }

  /**
   * Dismiss a notification
   * PATCH /notifications/:id/dismiss
   */
  @Patch(':id/dismiss')
  async dismiss(@Param('id') id: string): Promise<NotificationResponseDto> {
    return this.notificationsService.dismissNotification(id);
  }

  /**
   * Dismiss a notification through the legacy DELETE compatibility route.
   * DELETE /notifications/:id
   */
  @Delete(':id')
  async delete(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.notificationsService.dismissNotification(id);
    return { success: true };
  }
}
