import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type UploadDocument = Upload & Document;

@Schema({ timestamps: true })
export class Upload {
  @Prop()
  customerName: string;

  @Prop()
  phone: string;

  @Prop()
  note: string;

  @Prop()
  category: string;

  @Prop({ enum: ['pending', 'completed'], default: 'pending' })
  status: string;

  @Prop({ type: Array })
  files: {
    fileId: string;
    name: string;
    downloadUrl: string;
  }[];
}

export const UploadSchema = SchemaFactory.createForClass(Upload);
