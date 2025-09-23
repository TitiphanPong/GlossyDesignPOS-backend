import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type OrderDocument = Order & Document;

@Schema({ timestamps: true })
export class Order {
  // 👉 Base fields
  @Prop()
  orderId: string;

  // 👉 Customer info
  @Prop()
  customerName: string;

  @Prop()
  phoneNumber: string;

  @Prop()
  note: string; // หมายเหตุรวมทั้งบิล

  // 👉 Order summary
  @Prop({ required: true })
  total: number;

  @Prop({ default: 0 })
  discount: number;

  @Prop({ default: 0 })
  depositTotal: number;

  @Prop({ default: 0 })
  remainingTotal: number;

  @Prop({ enum: ['cash', 'promptpay'], required: true })
  payment: 'cash' | 'promptpay';

  @Prop({
    enum: ['pending', 'partial', 'paid', 'cancelled'],
    default: 'pending',
  })
  status: 'pending' | 'partial' | 'paid' | 'cancelled';

  @Prop({ enum: ['yes', 'no'], default: 'no' })
  taxInvoice: 'yes' | 'no';

  @Prop({ default: 0 })
  vatAmount: number;

  @Prop({
    type: [
      {
        amount: Number,
        method: { type: String, enum: ['cash', 'promptpay'] },
        paidAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  payments: { amount: number; method: 'cash' | 'promptpay'; paidAt: Date }[];

  // 👉 รายการสินค้า (cart)
  @Prop({
    type: [
      {
        name: String, // ชื่อสินค้า
        category: String, // ประเภทสินค้า เช่น นามบัตร, ตรายาง

        // --- นามบัตร ---
        variant: Object, // ขนาด/กระดาษ
        sides: String, // กี่ด้าน
        material: String, // วัสดุ
        colorMode: String, // โหมดสี

        // --- ตรายาง ---
        type: { type: String }, // normal | inked
        shape: { type: String }, // circle | square
        size: { type: String }, // ขนาดตรายาง

        // --- โพสการ์ด ---
        setCount: Number, // ✅ จำนวนชุด

        // --- ใช้ร่วมกัน ---
        qty: Number,
        unitPrice: Number,
        totalPrice: Number,
        productNote: String, // รายละเอียดสินค้า
        note: String, // หมายเหตุ
        deposit: Number,
        remaining: Number,
        fullPayment: Boolean,
      },
    ],
  })
  cart: {
    name: string;
    category?: string;

    // --- นามบัตร ---
    variant?: Record<string, any>;
    sides?: string;
    material?: string;
    colorMode?: string;

    // --- ตรายาง ---
    type?: string;
    shape?: string;
    size?: string;

    // --- โพสการ์ด ---
    setCount?: number; // ✅ จำนวนชุด

    // --- ใช้ร่วมกัน ---
    qty: number;
    unitPrice: number;
    totalPrice: number;
    productNote?: string;
    note?: string;
    deposit?: number;
    remaining?: number;
    fullPayment?: boolean;
  }[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);
