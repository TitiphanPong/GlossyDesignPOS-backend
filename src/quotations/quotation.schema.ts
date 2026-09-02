import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const QUOTATION_STATUSES = [
  'DRAFT',
  'SENT',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
  'CONVERTED',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];
export type QuotationDocument = HydratedDocument<Quotation>;

@Schema({ _id: false })
export class QuotationCustomerSnapshot {
  @Prop() customerName?: string;
  @Prop() phoneNumber?: string;
  @Prop() email?: string;
  @Prop() taxId?: string;
  @Prop() branchType?: string;
  @Prop() branchNo?: string;
  @Prop() address?: string;
  @Prop() subDistrict?: string;
  @Prop() district?: string;
  @Prop() province?: string;
  @Prop() postalCode?: string;
}
export const QuotationCustomerSnapshotSchema = SchemaFactory.createForClass(
  QuotationCustomerSnapshot,
);

@Schema({ _id: false })
export class QuotationPriceOverride {
  @Prop({ required: true }) unitPrice!: number;
  @Prop({ required: true, maxlength: 255 }) reason!: string;
  @Prop({ required: true }) approvedBy!: string;
  @Prop({ required: true, type: Date }) approvedAt!: Date;
}
export const QuotationPriceOverrideSchema = SchemaFactory.createForClass(
  QuotationPriceOverride,
);

@Schema({ _id: false })
export class QuotationItem {
  @Prop() productId?: string;
  @Prop() variantId?: string;
  @Prop() quickProductId?: string;
  @Prop() productCode?: string;
  @Prop() typeCode?: string;
  @Prop({ required: true }) name!: string;
  @Prop() description?: string;
  @Prop({ required: true, min: 1 }) quantity!: number;
  @Prop({ default: 'ชิ้น' }) unit!: string;
  @Prop({ required: true, min: 0 }) authoritativeUnitPrice!: number;
  @Prop({ required: true, min: 0 }) lineTotal!: number;
  @Prop({ type: QuotationPriceOverrideSchema })
  priceOverride?: QuotationPriceOverride;
  @Prop() variantName?: string;
  @Prop() material?: string;
  @Prop() colorMode?: string;
  @Prop() type?: string;
  @Prop() typePremium?: string;
  @Prop() shape?: string;
  @Prop() size?: string;
  @Prop() sides?: string;
  @Prop() productNote?: string;
  @Prop() note?: string;
  @Prop() setCount?: number;
  @Prop() inkjetType?: string;
  @Prop({ type: [{ height: String, width: String }], default: undefined })
  sizeFlex?: { height: string; width: string }[];
  @Prop() stickerPVCType?: string;
  @Prop() plotPlanType?: string;
}
export const QuotationItemSchema = SchemaFactory.createForClass(QuotationItem);

@Schema({ _id: false })
export class QuotationStatusHistoryEntry {
  @Prop({ required: true, type: String, enum: QUOTATION_STATUSES })
  status!: QuotationStatus;
  @Prop({ required: true }) action!: string;
  @Prop({ required: true }) actor!: string;
  @Prop({ required: true, type: Date }) timestamp!: Date;
  @Prop() reason?: string;
}
export const QuotationStatusHistoryEntrySchema = SchemaFactory.createForClass(
  QuotationStatusHistoryEntry,
);

@Schema({ _id: false })
export class QuotationRevisionSnapshot {
  @Prop({ required: true }) revision!: number;
  @Prop({ required: true, type: String, enum: QUOTATION_STATUSES })
  status!: QuotationStatus;
  @Prop() quotationNumber?: string;
  @Prop({ type: Date }) issuedAt?: Date;
  @Prop({ type: Date }) validUntil?: Date;
  @Prop({ type: QuotationCustomerSnapshotSchema, default: {} })
  customerSnapshot!: QuotationCustomerSnapshot;
  @Prop({ type: [QuotationItemSchema], default: [] })
  items!: QuotationItem[];
  @Prop({ required: true, default: 0 }) subtotal!: number;
  @Prop({ required: true, default: 0 }) discount!: number;
  @Prop({ type: String, enum: ['amount', 'percent'] })
  discountType?: 'amount' | 'percent';
  @Prop({ min: 0 }) discountValue?: number;
  @Prop({ required: true, default: 0 }) taxableAmount!: number;
  @Prop({ required: true, default: 7 }) vatRate!: number;
  @Prop({ required: true, default: 0 }) vatAmount!: number;
  @Prop({ required: true, default: 0 }) grandTotal!: number;
  @Prop({ required: true, default: false }) taxInvoiceRequested!: boolean;
  @Prop({ required: true, type: String, default: 'THB' }) currency!: 'THB';
  @Prop() subject?: string;
  @Prop() notes?: string;
  @Prop() termsAndConditions?: string;
  @Prop() paymentTerms?: string;
  @Prop() deliveryTerms?: string;
  @Prop() internalNote?: string;
  @Prop({ required: true }) snapshotBy!: string;
  @Prop({ required: true, type: Date }) snapshotAt!: Date;
}
export const QuotationRevisionSnapshotSchema = SchemaFactory.createForClass(
  QuotationRevisionSnapshot,
);

@Schema({
  timestamps: true,
  collection: 'quotations',
  optimisticConcurrency: true,
})
export class Quotation {
  @Prop({ unique: true, sparse: true, index: true })
  quotationNumber?: string;

  @Prop({ required: true, default: 0, min: 0 })
  revision!: number;

  @Prop({
    required: true,
    type: String,
    enum: QUOTATION_STATUSES,
    default: 'DRAFT',
    index: true,
  })
  status!: QuotationStatus;

  @Prop({ type: Date, index: true })
  issuedAt?: Date;

  @Prop({ type: Date, index: true })
  validUntil?: Date;

  @Prop({ required: true }) createdBy!: string;
  @Prop({ required: true }) updatedBy!: string;

  @Prop({ type: Types.ObjectId, ref: 'Customer', index: true })
  customerId?: Types.ObjectId;

  @Prop({ type: QuotationCustomerSnapshotSchema, default: {} })
  customerSnapshot!: QuotationCustomerSnapshot;

  @Prop({ type: [QuotationItemSchema], default: [] })
  items!: QuotationItem[];

  @Prop({ required: true, default: 0 }) subtotal!: number;
  @Prop({ required: true, default: 0 }) discount!: number;
  @Prop({ type: String, enum: ['amount', 'percent'] })
  discountType?: 'amount' | 'percent';
  @Prop({ min: 0 }) discountValue?: number;
  @Prop({ required: true, default: 0 }) taxableAmount!: number;
  @Prop({ required: true, default: 7 }) vatRate!: number;
  @Prop({ required: true, default: 0 }) vatAmount!: number;
  @Prop({ required: true, default: 0 }) grandTotal!: number;
  @Prop({ required: true, default: false }) taxInvoiceRequested!: boolean;
  @Prop({ required: true, type: String, default: 'THB' }) currency!: 'THB';

  @Prop() subject?: string;
  @Prop() notes?: string;
  @Prop() termsAndConditions?: string;
  @Prop() paymentTerms?: string;
  @Prop() deliveryTerms?: string;
  @Prop() internalNote?: string;
  @Prop() rejectionReason?: string;
  @Prop() cancellationReason?: string;

  @Prop({ type: Types.ObjectId, ref: 'Order', index: true })
  convertedOrderId?: Types.ObjectId;
  @Prop({ type: Date }) convertedAt?: Date;
  @Prop() convertedBy?: string;
  @Prop({ maxlength: 128 }) conversionIdempotencyKey?: string;
  @Prop({ match: /^[a-f0-9]{64}$/ }) conversionFingerprint?: string;

  @Prop({ type: [QuotationStatusHistoryEntrySchema], default: [] })
  statusHistory!: QuotationStatusHistoryEntry[];

  @Prop({ type: [QuotationRevisionSnapshotSchema], default: [] })
  revisionHistory!: QuotationRevisionSnapshot[];
}

export const QuotationSchema = SchemaFactory.createForClass(Quotation);
QuotationSchema.index({ status: 1, updatedAt: -1 });
QuotationSchema.index({ customerId: 1, updatedAt: -1 });
QuotationSchema.index({ issuedAt: -1, quotationNumber: 1 });
QuotationSchema.index({ validUntil: 1, status: 1 });
