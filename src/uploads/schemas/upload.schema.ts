import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { JobType, UploadStage, UploadStatus } from '../uploads.enums';

export type UploadDocument = Upload & Document;

@Schema({ timestamps: true })
export class Upload {
  @Prop({ required: true, unique: true, index: true })
  uploadId!: string;

  @Prop({ required: true, unique: true, index: true })
  orderCode!: string;

  @Prop({ maxlength: 120 })
  customerName?: string;

  @Prop({ maxlength: 20 })
  phone?: string;

  @Prop({ index: true })
  lineUserId?: string;

  @Prop({ maxlength: 120 })
  displayName?: string;

  @Prop()
  category?: string;

  @Prop()
  note?: string;

  @Prop()
  statusNote?: string;

  @Prop()
  batchId?: string;

  @Prop({ type: String, index: true })
  linkedOrderId?: string;

  @Prop({ type: String, index: true })
  linkedOrderNumber?: string;

  @Prop({
    type: String,
    enum: Object.values(UploadStage),
  })
  stage?: UploadStage;

  @Prop({ type: String, required: true, enum: Object.values(JobType) })
  jobType!: JobType;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(UploadStatus),
    default: UploadStatus.PENDING,
  })
  status!: UploadStatus;

  @Prop({
    type: [
      {
        originalName: { type: String, required: true },
        sanitizedName: { type: String, required: true },
        fileId: { type: String },
        name: { type: String },
        downloadUrl: { type: String },
        previewUrl: { type: String },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        s3Key: { type: String, required: true },
      },
    ],
    required: true,
  })
  files!: Array<{
    originalName: string;
    sanitizedName: string;
    fileId?: string;
    name?: string;
    downloadUrl?: string;
    previewUrl?: string;
    mimeType: string;
    size: number;
    s3Key: string;
  }>;
}

export const UploadSchema = SchemaFactory.createForClass(Upload);

UploadSchema.index({ createdAt: -1, status: 1 });
