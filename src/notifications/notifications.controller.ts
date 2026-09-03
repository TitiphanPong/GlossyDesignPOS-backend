import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  Request,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import {
  ActionCenterDto,
  ActionCenterUserStateResultDto,
  ActiveNotificationsQueryDto,
  ListNotificationsQueryDto,
  MarkNotificationReadDto,
  NotificationCountDto,
  NotificationResponseDto,
  UpdateActionCenterUserStateDto,
} from './dto/notification.dto';
import type { AuthenticatedUser } from '../auth/auth.types';

type AuthRequest = { user: AuthenticatedUser };

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Get the cashier action center in one consistent, user-aware snapshot.
   * GET /notifications/action-center
   */
  @Get('action-center')
  async getActionCenter(
    @Request() request: AuthRequest,
  ): Promise<ActionCenterDto> {
    return this.notificationsService.getActionCenter(request.user.id);
  }

  /**
   * Update only the current user's Action Center visibility state. This never
   * resolves the underlying operational condition.
   * PATCH /notifications/action-center/state
   */
  @Patch('action-center/state')
  async updateActionCenterState(
    @Request() request: AuthRequest,
    @Body() body: UpdateActionCenterUserStateDto,
  ): Promise<ActionCenterUserStateResultDto> {
    return this.notificationsService.updateActionCenterUserState(
      request.user.id,
      body,
    );
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
   * Get notification count badge (legacy global count endpoint).
   * GET /notifications/count
   */
  @Get('count')
  async getCount(): Promise<NotificationCountDto> {
    return this.notificationsService.getNotificationCount();
  }

  /**
   * List all notifications with filters.
   * GET /notifications?status=active&category=action_required&limit=50&skip=0
   */
  @Get()
  async list(@Query() query: ListNotificationsQueryDto) {
    return this.notificationsService.listNotifications(query);
  }

  /** Mark notification as read/unread (legacy global compatibility state). */
  @Patch(':id/read')
  async markAsRead(
    @Param('id') id: string,
    @Body() body: MarkNotificationReadDto,
  ): Promise<NotificationResponseDto> {
    return this.notificationsService.markAsRead(id, body.isRead);
  }

  /** Resolve a non-operational informational notification. */
  @Patch(':id/resolve')
  async resolve(@Param('id') id: string): Promise<NotificationResponseDto> {
    return this.notificationsService.resolveNotification(id);
  }

  /** Dismiss a non-operational informational notification. */
  @Patch(':id/dismiss')
  async dismiss(@Param('id') id: string): Promise<NotificationResponseDto> {
    return this.notificationsService.dismissNotification(id);
  }

  /** Legacy DELETE compatibility route for informational notifications. */
  @Delete(':id')
  async delete(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.notificationsService.dismissNotification(id);
    return { success: true };
  }
}
