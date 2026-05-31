import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PaymentMethod = 'cash' | 'promptpay';
export type OrderStatus = 'pending' | 'partial' | 'paid' | 'cancelled';
export type OrderDocument = HydratedDocument<Order>;

@Schema({ timestamps: true })
export class Order {
  @Prop({ unique: true, sparse: true, index: true })
  clientDraftId?: string;

  @Prop()
  orderId?: string;

  @Prop({ unique: true, sparse: true, index: true })
  orderNumber?: string;

  @Prop()
  customerName!: string;

  @Prop()
  phoneNumber!: string;

  @Prop()
  email?: string;

  @Prop()
  address?: string;

  @Prop()
  customerAddress?: string;

  @Prop()
  taxId?: string;

  @Prop()
  customerTaxId?: string;

  @Prop()
  branch?: string;

  @Prop()
  note!: string;

  @Prop()
  salesChannel?: string;

  @Prop({ required: true })
  total!: number;

  @Prop({ default: 0 })
  discount!: number;

  @Prop({ default: 0 })
  depositTotal!: number;

  @Prop({ default: 0 })
  remainingTotal!: number;

  @Prop({ enum: ['cash', 'promptpay'], required: true })
  payment!: PaymentMethod;

  @Prop({
    enum: ['pending', 'partial', 'paid', 'cancelled'],
    default: 'pending',
  })
  status!: OrderStatus;

  @Prop({ enum: ['yes', 'no'], default: 'no' })
  taxInvoice!: 'yes' | 'no';

  @Prop({ default: 0 })
  vatAmount!: number;

  @Prop({ default: 0 })
  grandTotal!: number;

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
  payments!: { amount: number; method: PaymentMethod; paidAt: Date }[];

  @Prop({
    type: [
      {
        name: String,
        category: String,
        variant: Object,
        sides: String,
        material: String,
        colorMode: String,
        type: { type: String },
        shape: { type: String },
        size: { type: String },
        setCount: Number,
        inkjetType: { type: String },
        sizeFlex: [
          {
            height: String,
            width: String,
          },
        ],
        stickerPVCType: String,
        qty: Number,
        unitPrice: Number,
        totalPrice: Number,
        productNote: String,
        note: String,
        deposit: Number,
        remaining: Number,
        fullPayment: Boolean,
      },
    ],
  })
  cart!: {
    name: string;
    category?: string;
    variant?: Record<string, unknown>;
    sides?: string;
    material?: string;
    colorMode?: string;
    type?: string;
    shape?: string;
    size?: string;
    setCount?: number;
    inkjetType?: string;
    sizeFlex?: { height: string; width: string }[];
    stickerPVCType?: string;
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

OrderSchema.index({ orderNumber: 1 }, { unique: true, sparse: true });
OrderSchema.index({ clientDraftId: 1 }, { unique: true, sparse: true });
