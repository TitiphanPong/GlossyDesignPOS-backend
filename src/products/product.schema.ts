// src/products/product.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ProductDocument = Product & Document;

@Schema({ timestamps: true })
export class Product {
  @Prop({ required: true })
  name: string;

  @Prop()
  cover?: string;

  @Prop()
  tint?: string;

  @Prop()
  category: string;

  @Prop()
  badge?: 'NEW' | 'HIT';

  @Prop([
    {
      name: { type: String, required: true },
      price: { type: Number, required: true },
      note: { type: String },
    },
  ])
  variants: {
    name: string;
    price: number;
    note?: string;
  }[];
}

export const ProductSchema = SchemaFactory.createForClass(Product);