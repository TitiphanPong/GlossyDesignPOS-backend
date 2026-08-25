import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const COUNTER_TYPE_ORDER = 'ORDER' as const;
export const COUNTER_TYPE_TAX_INVOICE = 'TAX_INVOICE' as const;
export type CounterType =
  | typeof COUNTER_TYPE_ORDER
  | typeof COUNTER_TYPE_TAX_INVOICE;
export type CounterDocument = HydratedDocument<Counter>;

@Schema({
  collection: 'counters',
  versionKey: false,
  timestamps: false,
})
export class Counter {
  @Prop({
    required: true,
    enum: [COUNTER_TYPE_ORDER, COUNTER_TYPE_TAX_INVOICE],
  })
  type!: CounterType;

  @Prop({ required: true, min: 2000 })
  year!: number;

  @Prop({ required: true, default: 0, min: 0 })
  seq!: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);

CounterSchema.index({ type: 1, year: 1 }, { unique: true });
