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
export const ORDER_TYPES = ['NORMAL', 'QUICK_SALE'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];
export const ORDER_ENTRY_MODES = ['normal', 'backdated'] as const;
export type OrderEntryMode = (typeof ORDER_ENTRY_MODES)[number];

@Schema({ timestamps: true })
export class Order {
  @Prop({ type: String, enum: ORDER_TYPES, default: 'NORMAL', index: true })
  orderType!: OrderType;

  @Prop({ unique: true, sparse: true })
  clientDraftId?: string;

  @Prop()
  orderId?: string;

  @Prop({ type: Date, index: true })
  saleDate?: Date;

  @Prop({ type: String, enum: ORDER_ENTRY_MODES, default: 'normal' })
  entryMode!: OrderEntryMode;

  @Prop({ type: Boolean, default: false })
  isBackdated!: boolean;

  @Prop({ maxlength: 1000 })
  backdatedReason?: string;

  @Prop({ unique: true, sparse: true })
  idempotencyKey?: string;

  @Prop({ match: /^[a-f0-9]{64}$/ })
  createCommandFingerprint?: string;

  @Prop({ unique: true, sparse: true })
  orderNumber?: string;

  @Prop({ unique: true, sparse: true })
  invoiceNumber?: string;

  @Prop({ match: /^\d{3}$/ })
  bookNo?: string;

  @Prop({ match: /^\d{3}$/ })
  invoiceSequence?: string;

  @Prop({ match: /^\d{6}$/ })
  invoicePeriod?: string;

  @Prop()
  customerName!: string;

  @Prop()
  companyName?: string;

  @Prop()
  phoneNumber!: string;

  @Prop()
  email?: string;

  @Prop()
  customerEmail?: string;

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
  customerBranch?: string;

  @Prop()
  branchType?: string;

  @Prop()
  branchNo?: string;

  @Prop()
  subDistrict?: string;

  @Prop()
  district?: string;

  @Prop()
  province?: string;

  @Prop()
  postalCode?: string;

  @Prop()
  shippingAddress?: string;

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

  @Prop()
  receivedAmount?: number;

  @Prop()
  changeAmount?: number;

  @Prop({
    type: [
      {
        amount: Number,
        method: { type: String, enum: PAYMENT_METHODS },
        note: String,
        idempotencyKey: { type: String, maxlength: 128 },
        paidAt: { type: Date, default: Date.now },
      },
    ],
    default: [],
  })
  payments!: {
    amount: number;
    method: PaymentMethod;
    note?: string;
    idempotencyKey?: string;
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
        variant: {
          id: String,
          _id: String,
          name: String,
          price: Number,
          note: String,
          material: String,
          sides: String,
          size: String,
          active: Boolean,
          custom: Boolean,
          width: Number,
          height: Number,
        },
        sides: String,
        material: String,
        colorMode: String,
        type: { type: String },
        typePremium: { type: String },
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
        plotPlanType: String,
        qty: Number,
        unitPrice: Number,
        totalPrice: Number,
        lineTotal: Number,
        productNote: String,
        note: String,
        deposit: Number,
        remaining: Number,
        fullPayment: Boolean,
      },
    ],
  })
  cart!: {
    key?: string;
    productId?: string;
    productCode?: string;
    typeCode?: string;
    name: string;
    category?: string;
    variantName?: string;
    variant?: {
      id?: string;
      _id?: string;
      name: string;
      price?: number;
      note?: string;
      material?: string;
      sides?: string;
      size?: string;
      active?: boolean;
      custom?: boolean;
      width?: number;
      height?: number;
    };
    sides?: string;
    material?: string;
    colorMode?: string;
    type?: string;
    typePremium?: string;
    shape?: string;
    size?: string;
    setCount?: number;
    inkjetType?: string;
    sizeFlex?: { height: string; width: string }[];
    stickerPVCType?: string;
    plotPlanType?: string;
    qty: number;
    unitPrice: number;
    totalPrice: number;
    lineTotal?: number;
    productNote?: string;
    note?: string;
    deposit?: number;
    remaining?: number;
    fullPayment?: boolean;
  }[];
}

export const OrderSchema = SchemaFactory.createForClass(Order);

OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ orderType: 1, createdAt: -1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ saleDate: 1, status: 1 });
