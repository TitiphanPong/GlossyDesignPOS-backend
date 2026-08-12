import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AuditEventDocument = HydratedDocument<AuditEvent>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AuditEvent {
  @Prop({ type: Types.ObjectId, ref: 'User', index: true })
  actorId?: Types.ObjectId;

  @Prop({ required: true, maxlength: 120 })
  actorUsername: string;

  @Prop({ required: true, index: true, maxlength: 120 })
  action: string;

  @Prop({ maxlength: 80 })
  targetType?: string;

  @Prop({ maxlength: 120 })
  targetId?: string;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, string | number | boolean | null>;
}

export const AuditEventSchema = SchemaFactory.createForClass(AuditEvent);
AuditEventSchema.index({ createdAt: -1 });
AuditEventSchema.index({ action: 1, createdAt: -1 });
