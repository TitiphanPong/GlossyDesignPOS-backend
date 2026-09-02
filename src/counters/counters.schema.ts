import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const COUNTER_TYPE_ORDER = 'ORDER' as const;
export const COUNTER_TYPE_TAX_INVOICE = 'TAX_INVOICE' as const;
export const COUNTER_TYPE_QUOTATION = 'QUOTATION' as const;
export type CounterType =
  | typeof COUNTER_TYPE_ORDER
  | typeof COUNTER_TYPE_TAX_INVOICE
  | typeof COUNTER_TYPE_QUOTATION;
export type CounterDocument = HydratedDocument<Counter>;

@Schema({
  collection: 'counters',
  versionKey: false,
  timestamps: false,
})
export class Counter {
  @Prop({
    required: true,
    enum: [
      COUNTER_TYPE_ORDER,
      COUNTER_TYPE_TAX_INVOICE,
      COUNTER_TYPE_QUOTATION,
    ],
  })
  type!: CounterType;

  // Historical name retained for index compatibility. ORDER uses YYYY,
  // TAX_INVOICE uses its approved counter period, QUOTATION uses YYYYMM.
  @Prop({ required: true, min: 2000 })
  year!: number;

  @Prop({ required: true, default: 0, min: 0 })
  seq!: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);
CounterSchema.index({ type: 1, year: 1 }, { unique: true });
