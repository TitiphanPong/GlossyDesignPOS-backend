import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StockItemDocument = HydratedDocument<StockItem>;

@Schema({ collection: 'stock_items', timestamps: true })
export class StockItem {
  @Prop({
    required: true,
    unique: true,
    index: true,
    trim: true,
    maxlength: 80,
  })
  code!: string;

  @Prop({ required: true, trim: true, maxlength: 200 })
  name!: string;

  @Prop({ required: true, trim: true, maxlength: 40 })
  unit!: string;

  @Prop({ required: true, default: 0, min: 0 })
  onHand!: number;

  @Prop({ required: true, default: 0, min: 0 })
  minimumLevel!: number;

  @Prop({ required: true, default: true, index: true })
  active!: boolean;
}

export const StockItemSchema = SchemaFactory.createForClass(StockItem);
StockItemSchema.index({ active: 1, name: 1 });
