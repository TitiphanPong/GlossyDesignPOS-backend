import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ timestamps: true })
export class Order {
  // 👉 Base fields

  @Prop()
  orderId: string;

  @Prop()
  customerName: string;

  @Prop()
  companyName: string;

  @Prop()
  note: string;

  @Prop({ required: true })
  category: string;

  @Prop({ required: true })
  total: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ enum: ['cash', 'promptpay'], required: true })
  payment: 'cash' | 'promptpay';

  @Prop({ enum: ['pending', 'paid', 'cancelled'], default: 'pending' })
  status: string;

  // 👉 รายการสินค้า (cart)
  @Prop({
    type: [
      {
        name: String, // ชื่อสินค้า เช่น นามบัตร
        unitPrice: Number, // ราคาต่อหน่วย
        totalPrice: Number, // ราคารวม
        extra: { type: Object }, // รายละเอียดเฉพาะแต่ละ Category
      },
    ],
  })
  cart: {
    name: string;
    unitPrice: number;
    totalPrice: number;
    extra?: Record<string, any>;
  }[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);
