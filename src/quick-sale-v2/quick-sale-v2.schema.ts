import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type QuickSaleV2ConfigDocument = HydratedDocument<QuickSaleV2Config>;

@Schema({ _id: false })
export class QuickSaleV2DocumentMapping {
  @Prop({ required: true, enum: ['print', 'copy', 'scan'] })
  workType: 'print' | 'copy' | 'scan';

  @Prop({ required: true, enum: ['A4', 'A3'] })
  size: 'A4' | 'A3';

  @Prop({ required: true, enum: ['bw', 'color'] })
  colorMode: 'bw' | 'color';

  @Prop({ type: Types.ObjectId, ref: 'QuickProduct', required: true })
  quickProductId: Types.ObjectId;
}

export const QuickSaleV2DocumentMappingSchema = SchemaFactory.createForClass(
  QuickSaleV2DocumentMapping,
);

@Schema({ _id: false })
export class QuickSaleV2DocumentDefaults {
  @Prop({ required: true, enum: ['print', 'copy', 'scan'], default: 'print' })
  workType: 'print' | 'copy' | 'scan';

  @Prop({ required: true, enum: ['A4', 'A3'], default: 'A4' })
  size: 'A4' | 'A3';

  @Prop({ required: true, enum: ['bw', 'color'], default: 'bw' })
  colorMode: 'bw' | 'color';

  @Prop({ required: true, type: Number, min: 1, max: 999, default: 1 })
  quantity: number;
}

export const QuickSaleV2DocumentDefaultsSchema = SchemaFactory.createForClass(
  QuickSaleV2DocumentDefaults,
);

@Schema({ collection: 'quick_sale_v2_configs', timestamps: true })
export class QuickSaleV2Config {
  @Prop({ required: true, unique: true, default: 'default' })
  key: string;

  @Prop({ type: [QuickSaleV2DocumentMappingSchema], default: [] })
  draftMappings: QuickSaleV2DocumentMapping[];

  @Prop({ type: QuickSaleV2DocumentDefaultsSchema, default: () => ({}) })
  draftDefaults: QuickSaleV2DocumentDefaults;

  @Prop({ type: [QuickSaleV2DocumentMappingSchema], default: [] })
  publishedMappings: QuickSaleV2DocumentMapping[];

  @Prop({ type: QuickSaleV2DocumentDefaultsSchema, default: () => ({}) })
  publishedDefaults: QuickSaleV2DocumentDefaults;

  @Prop({ type: Number, default: 0 })
  publishedVersion: number;

  createdAt?: Date;
  updatedAt?: Date;
}

export const QuickSaleV2ConfigSchema =
  SchemaFactory.createForClass(QuickSaleV2Config);
