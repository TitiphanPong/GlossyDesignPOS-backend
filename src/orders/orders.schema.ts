import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ timestamps: true })
export class Order {
  @Prop({ required: true })
  orderId: string;

  @Prop({
    type: [
      {
        category: String,
        name: String,
        variant: String,
        qty: Number,
        unitPrice: Number,
        totalPrice: Number,
        extra: { type: Object },
      },
    ],
  })
  cart: any[];

  @Prop({ required: true })
  total: number;

  @Prop({ enum: ['cash', 'promptpay'], required: true })
  payment: 'cash' | 'promptpay';

  @Prop({ enum: ['pending', 'paid', 'cancelled'], default: 'pending' })
  status: string;
}

export const OrderSchema = SchemaFactory.createForClass(Order);
