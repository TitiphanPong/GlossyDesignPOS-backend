import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { StockItem } from './stock-item.schema';

export const STOCK_MOVEMENT_TYPES = [
  'receive',
  'issue',
  'adjustment_in',
  'adjustment_out',
  'waste',
] as const;

export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export type StockMovementDocument = HydratedDocument<StockMovement>;

@Schema({
  collection: 'stock_movements',
  timestamps: { createdAt: true, updatedAt: false },
})
export class StockMovement {
  @Prop({
    type: Types.ObjectId,
    ref: StockItem.name,
    required: true,
    index: true,
  })
  stockItemId!: Types.ObjectId;

  @Prop({
    type: String,
    enum: STOCK_MOVEMENT_TYPES,
    required: true,
    index: true,
  })
  type!: StockMovementType;

  @Prop({ required: true, min: 0 })
  quantity!: number;

  @Prop({ required: true })
  delta!: number;

  @Prop({ required: true, min: 0 })
  balanceAfter!: number;

  @Prop({ required: true, trim: true, maxlength: 500 })
  reason!: string;

  @Prop({ required: true, trim: true, maxlength: 128 })
  actorId!: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  actorUsername!: string;

  @Prop({ type: Date, required: true, default: Date.now, index: true })
  occurredAt!: Date;

  @Prop({ trim: true, maxlength: 80 })
  referenceType?: string;

  @Prop({ trim: true, maxlength: 160 })
  referenceId?: string;

  @Prop({ trim: true, maxlength: 160, index: true })
  orderId?: string;

  @Prop({ trim: true, maxlength: 160, index: true })
  orderNumber?: string;

  @Prop({ trim: true, maxlength: 160, index: true })
  productionJobId?: string;

  @Prop({ type: Object })
  reasonMetadata?: Record<string, unknown>;

  @Prop({ unique: true, sparse: true, trim: true, maxlength: 128 })
  idempotencyKey?: string;

  @Prop({ required: true, match: /^[a-f0-9]{64}$/ })
  commandFingerprint!: string;
}

export const StockMovementSchema = SchemaFactory.createForClass(StockMovement);
StockMovementSchema.index({ stockItemId: 1, occurredAt: -1 });
