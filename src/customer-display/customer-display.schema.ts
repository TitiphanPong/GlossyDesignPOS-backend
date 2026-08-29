import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, SchemaTypes } from 'mongoose';

@Schema({ timestamps: true, collection: 'customer_display_sessions' })
export class CustomerDisplaySession {
  createdAt?: Date;
  updatedAt?: Date;
  @Prop({ required: true, unique: true, index: true })
  sessionId!: string;

  @Prop({ required: true, unique: true, index: true, select: false })
  tokenHash!: string;

  @Prop({ required: true, index: true })
  createdBy!: string;

  @Prop({ type: SchemaTypes.Mixed, default: null })
  state!: object | null;

  @Prop({ required: true, index: { expires: 0 } })
  expiresAt!: Date;
}

export type CustomerDisplaySessionDocument =
  HydratedDocument<CustomerDisplaySession>;
export const CustomerDisplaySessionSchema = SchemaFactory.createForClass(
  CustomerDisplaySession,
);
