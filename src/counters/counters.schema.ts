import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export const COUNTER_TYPE_ORDER = 'ORDER' as const;
export type CounterType = typeof COUNTER_TYPE_ORDER;
export type CounterDocument = HydratedDocument<Counter>;

@Schema({
  collection: 'counters',
  versionKey: false,
  timestamps: false,
})
export class Counter {
  @Prop({ required: true, enum: [COUNTER_TYPE_ORDER] })
  type!: CounterType;

  @Prop({ required: true, match: /^\d{8}$/ })
  date!: string;

  @Prop({ required: true, default: 0, min: 0 })
  seq!: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);

CounterSchema.index({ type: 1, date: 1 }, { unique: true });
