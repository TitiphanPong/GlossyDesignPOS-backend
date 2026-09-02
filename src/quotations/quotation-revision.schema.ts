import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  Quotation,
  QuotationRevisionSnapshot,
  QuotationRevisionSnapshotSchema,
} from './quotation.schema';

export type QuotationRevisionRecordDocument =
  HydratedDocument<QuotationRevisionRecord>;

@Schema({
  timestamps: true,
  collection: 'quotation_revisions',
})
export class QuotationRevisionRecord {
  @Prop({
    required: true,
    type: Types.ObjectId,
    ref: Quotation.name,
    index: true,
  })
  quotationId!: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  revision!: number;

  @Prop({ required: true, type: QuotationRevisionSnapshotSchema })
  snapshot!: QuotationRevisionSnapshot;
}

export const QuotationRevisionRecordSchema = SchemaFactory.createForClass(
  QuotationRevisionRecord,
);
QuotationRevisionRecordSchema.index(
  { quotationId: 1, revision: 1 },
  { unique: true },
);
