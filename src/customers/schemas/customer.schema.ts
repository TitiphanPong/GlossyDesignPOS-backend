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
