import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const PAYMENT_METHODS = ['cash', 'promptpay'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const ORDER_STATUSES = [
  'pending',
  'producing',
  'awaiting_payment',
  'ready_for_pickup',
  'delivered',
  'cancelled',
  'partial',
  'paid',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderDocument = HydratedDocument<Order>;

@Schema({ timestamps: true })
export class Order {
  @Prop({ unique: true, sparse: true })
  clientDraftId?: string;

  @Prop()
  orderId?: string;

  @Prop({ unique: true, sparse: true })
  idempotencyKey?: string;

  @Prop({ unique: true, sparse: true })
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
  subtotal!: number;

  @Prop({ default: 0 })
  discount!: number;

  @Prop({ default: 0 })
  depositTotal!: number;

  @Prop({ default: 0 })
  paidAmount!: number;

  @Prop({ default: 0 })
  remainingTotal!: number;

  @Prop({ type: String, enum: PAYMENT_METHODS, required: true })
  payment!: PaymentMethod;

  @Prop({ type: String, enum: PAYMENT_METHODS })
  paymentMethod?: PaymentMethod;

  @Prop({
    type: String,
    enum: ORDER_STATUSES,
    default: 'pending',
  })
  status!: OrderStatus;

  @Prop({ type: String, enum: ['yes', 'no'], default: 'no' })
  taxInvoice!: 'yes' | 'no';

  @Prop({ default: 0 })
  vatAmount!: number;

  @Prop({ default: 0 })
  grandTotal!: number;

  @Prop({
    type: [
      {
        amount: Number,
        method: { type: String, enum: PAYMENT_METHODS },
        note: String,
        paidAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  payments!: {
    amount: number;
    method: PaymentMethod;
    note?: string;
    paidAt: Date;
  }[];

  @Prop({
    type: [
      {
        status: { type: String, enum: ORDER_STATUSES, required: true },
        note: String,
        changedAt: { type: Date, default: Date.now },
        changedBy: String,
      },
    ],
    default: [],
  })
  statusHistory!: {
    status: OrderStatus;
    note?: string;
    changedAt: Date;
    changedBy?: string;
  }[];

  @Prop({
    type: [
      {
        productId: String,
        productCode: String,
        typeCode: String,
        name: String,
        category: String,
        variantName: String,
        variant: Object,
        sides: Number,
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
    productId?: string;
    productCode?: string;
    typeCode?: string;
    name: string;
    category?: string;
    variantName?: string;
    variant?: Record<string, unknown>;
    sides?: number;
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

OrderSchema.index({ status: 1, createdAt: -1 });
