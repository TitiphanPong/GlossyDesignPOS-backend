import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CustomerDocument = HydratedDocument<Customer>;

@Schema({ timestamps: true })
export class Customer {
  @Prop({ required: true, unique: true, index: true })
  customerCode!: string;

  @Prop({ required: true, maxlength: 120, index: true })
  displayName!: string;

  @Prop({ maxlength: 20, index: true })
  phoneNumber?: string;

  @Prop({ type: [String], default: [], index: true })
  phoneNumbers!: string[];

  @Prop({ maxlength: 160, index: true })
  email?: string;

  @Prop({ maxlength: 13, index: true })
  taxId?: string;

  @Prop({ maxlength: 160 })
  companyName?: string;

  @Prop({ maxlength: 500 })
  address?: string;

  @Prop({ maxlength: 80 })
  branchType?: string;

  @Prop({ maxlength: 20 })
  branchNo?: string;

  @Prop({ maxlength: 120 })
  subDistrict?: string;

  @Prop({ maxlength: 120 })
  district?: string;

  @Prop({ maxlength: 120 })
  province?: string;

  @Prop({ maxlength: 10 })
  postalCode?: string;

  @Prop({ maxlength: 500 })
  shippingAddress?: string;

  @Prop({ default: true, index: true })
  active!: boolean;
}

export const CustomerSchema = SchemaFactory.createForClass(Customer);
CustomerSchema.index({ displayName: 1, phoneNumber: 1 });
CustomerSchema.path('phoneNumbers').validate(
  (values: unknown[]) =>
    Array.isArray(values) &&
    values.every(
      (value) =>
        typeof value === 'string' && value.length > 0 && value.length <= 20,
    ),
  'Each customer phone number must contain 1-20 characters.',
);
