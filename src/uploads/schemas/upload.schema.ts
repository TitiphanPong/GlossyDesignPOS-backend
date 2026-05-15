import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { JobType } from '../dto/create-upload.dto';

export type UploadDocument = Upload & Document;
export enum UploadStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
}

@Schema({ timestamps: true })
export class Upload {
  @Prop({ required: true, unique: true, index: true })
  uploadId: string;

  @Prop({ required: true, unique: true, index: true })
  orderCode: string;

  @Prop({ required: true, maxlength: 120 })
  customerName: string;

  @Prop({ required: true, maxlength: 20 })
  phone: string;

  @Prop()
  note?: string;

  @Prop({ type: String, required: true, enum: Object.values(JobType) })
  jobType: JobType;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(UploadStatus),
    default: UploadStatus.PENDING,
  })
  status: UploadStatus;

  @Prop({
    type: [
      {
        originalName: { type: String, required: true },
        sanitizedName: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        s3Key: { type: String, required: true },
      },
    ],
    required: true,
  })
  files: Array<{
    originalName: string;
    sanitizedName: string;
    mimeType: string;
    size: number;
    s3Key: string;
  }>;
}

export const UploadSchema = SchemaFactory.createForClass(Upload);
