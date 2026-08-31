// src/products/product.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProductDocument = HydratedDocument<Product>;

export type MaterialRecipeComponent = {
  stockItemId: string;
  quantity: number;
  unit: string;
  conversionFactor?: number;
};

export type ProductVariant = {
  name: string;
  code?: string;
  price: number;
  note?: string;
  material?: string;
  sides?: string;
  size?: string;
  active: boolean;
  sortOrder?: number;
  recipe?: MaterialRecipeComponent[];
};

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop({ required: true, unique: true, index: true, trim: true })
  code: string;

  @Prop({ required: true, unique: true, index: true, trim: true })
  typeCode: string;

  @Prop({ index: true })
  category: string;

  @Prop()
  cover?: string;

  @Prop()
  icon?: string;

  @Prop()
  emoji?: string;

  @Prop()
  tint?: string;

  @Prop()
  badge?: string;

  @Prop()
  description?: string;

  @Prop({ default: true, index: true })
  active: boolean;

  @Prop()
  sortOrder?: number;

  @Prop({ default: false, index: true })
  quickSaleEnabled?: boolean;

  @Prop({ default: false, index: true })
  isHotMenu?: boolean;

  @Prop()
  quickSaleSortOrder?: number;

  @Prop()
  deletedAt?: Date;

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
      recipe: [
        {
          stockItemId: { type: String, required: true, trim: true },
          quantity: { type: Number, required: true, min: 0.000001 },
          unit: { type: String, required: true, trim: true },
          conversionFactor: { type: Number, min: 0.000001 },
          _id: false,
        },
      ],
    },
  ])
  variants: ProductVariant[];

  @Prop([
    {
      stockItemId: { type: String, required: true, trim: true },
      quantity: { type: Number, required: true, min: 0.000001 },
      unit: { type: String, required: true, trim: true },
      conversionFactor: { type: Number, min: 0.000001 },
      _id: false,
    },
  ])
  recipe?: MaterialRecipeComponent[];
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.index({ category: 1, active: 1, sortOrder: 1 });
