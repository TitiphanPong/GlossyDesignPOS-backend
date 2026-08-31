import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import type { ProductVariant } from '../products/product.schema';

export type QuickProductDocument = HydratedDocument<QuickProduct>;

@Schema({ collection: 'quick_products', timestamps: true })
export class QuickProduct {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true, index: true, trim: true })
  code: string;

  @Prop({ required: true, unique: true, index: true, trim: true })
  typeCode: string;

  @Prop({ required: true, index: true })
  category: string;

  @Prop({ default: true, index: true })
  active: boolean;

  @Prop({ default: true, index: true })
  quickSaleEnabled: boolean;

  @Prop({ default: false, index: true })
  isHotMenu: boolean;

  @Prop({ required: true, index: true })
  quickSaleSortOrder: number;

  @Prop({ type: Types.ObjectId, ref: 'Product', index: true })
  productId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  variantId?: Types.ObjectId;

  @Prop({ enum: ['manual', 'p2-08-backfill'] })
  catalogLinkSource?: 'manual' | 'p2-08-backfill';

  @Prop()
  unitLabel?: string;

  @Prop({ required: true, enum: ['FIXED', 'STARTING_AT'] })
  priceDisplayMode: 'FIXED' | 'STARTING_AT';

  @Prop()
  icon?: string;

  @Prop()
  emoji?: string;

  @Prop()
  tint?: string;

  @Prop([
    {
      name: { type: String, required: true },
      code: { type: String },
      price: { type: Number, required: true },
      note: { type: String },
      material: { type: String },
      sides: { type: String },
      size: { type: String },
      active: { type: Boolean, default: true },
      sortOrder: { type: Number },
    },
  ])
  variants: ProductVariant[];
}

export const QuickProductSchema = SchemaFactory.createForClass(QuickProduct);
QuickProductSchema.index({ active: 1, quickSaleSortOrder: 1 });
