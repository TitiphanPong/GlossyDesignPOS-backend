import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const PRODUCTION_JOB_STAGES = [
  'file_check',
  'queued',
  'producing',
  'quality_check',
  'ready',
  'delivered',
] as const;
export type ProductionJobStage = (typeof PRODUCTION_JOB_STAGES)[number];

export const PRODUCTION_JOB_PRIORITIES = ['normal', 'rush'] as const;
export type ProductionJobPriority = (typeof PRODUCTION_JOB_PRIORITIES)[number];

export type ProductionJobDocument = HydratedDocument<ProductionJob>;

@Schema({ timestamps: true })
export class ProductionJob {
  @Prop({ required: true, unique: true, index: true })
  jobNumber!: string;

  @Prop({ type: Types.ObjectId, required: true, index: true, ref: 'Order' })
  orderId!: Types.ObjectId;

  @Prop({ required: true, index: true })
  orderNumber!: string;

  @Prop({ required: true, maxlength: 240 })
  workSummary!: string;

  @Prop({ maxlength: 80, index: true })
  jobType?: string;

  @Prop({ type: Date, required: true, index: true })
  dueAt!: Date;

  @Prop({
    type: String,
    enum: PRODUCTION_JOB_PRIORITIES,
    default: 'normal',
    index: true,
  })
  priority!: ProductionJobPriority;

  @Prop({ type: String, index: true })
  assigneeUserId?: string;

  @Prop({ maxlength: 120 })
  assigneeUsername?: string;

  @Prop({ maxlength: 2000 })
  internalNote?: string;

  @Prop({ type: [String], default: [] })
  linkedUploadIds!: string[];

  @Prop({ type: [Number], default: [] })
  orderLineIndexes!: number[];

  @Prop({ type: Date })
  materialIssueStartedAt?: Date;

  @Prop({ type: Date })
  materialIssuedAt?: Date;

  @Prop({
    type: String,
    enum: PRODUCTION_JOB_STAGES,
    default: 'file_check',
    index: true,
  })
  stage!: ProductionJobStage;

  @Prop({
    type: [
      {
        stage: { type: String, enum: PRODUCTION_JOB_STAGES, required: true },
        changedAt: { type: Date, required: true },
        changedBy: { type: String, required: true },
      },
    ],
    default: [],
  })
  stageHistory!: Array<{
    stage: ProductionJobStage;
    changedAt: Date;
    changedBy: string;
  }>;
}

export const ProductionJobSchema = SchemaFactory.createForClass(ProductionJob);
ProductionJobSchema.index({ orderId: 1, createdAt: -1 });
ProductionJobSchema.index({ stage: 1, dueAt: 1, priority: 1 });
ProductionJobSchema.index({ assigneeUserId: 1, stage: 1, dueAt: 1 });
