import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NotificationUserStateDocument =
  HydratedDocument<NotificationUserState>;

@Schema({ timestamps: true, collection: 'notification_user_states' })
export class NotificationUserState {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, index: true })
  notificationId!: string;

  @Prop()
  acknowledgedAt?: Date;

  @Prop()
  snoozedUntil?: Date;

  @Prop()
  dismissedAt?: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export const NotificationUserStateSchema = SchemaFactory.createForClass(
  NotificationUserState,
);

NotificationUserStateSchema.index(
  { userId: 1, notificationId: 1 },
  { unique: true },
);
NotificationUserStateSchema.index({ userId: 1, snoozedUntil: 1 });
