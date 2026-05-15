import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomInt, randomUUID } from 'crypto';
import dayjs from 'dayjs';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadResponseDto } from './dto/upload-response.dto';
import { Upload, UploadDocument } from './schemas/upload.schema';
import { S3Service } from './s3/s3.service';
import { sanitizeFilename } from './validators/upload-file.validator';

@Injectable()
export class UploadsService {
  constructor(
    @InjectModel(Upload.name)
    private readonly uploadModel: Model<UploadDocument>,
    private readonly s3Service: S3Service,
  ) {}

  async createUpload(
    dto: CreateUploadDto,
    files: Express.Multer.File[],
  ): Promise<UploadResponseDto> {
    const uploadId = randomUUID();
    const orderCode = this.generateOrderCode();
    const now = new Date();
    const yyyy = dayjs(now).format('YYYY');
    const mm = dayjs(now).format('MM');

    const uploadedFiles: Upload['files'] = [];

    for (const file of files) {
      const sanitizedName = sanitizeFilename(file.originalname);
      const s3Key = `uploads/${yyyy}/${mm}/${uploadId}/${sanitizedName}`;

      await this.s3Service.uploadPrivateObject({
        key: s3Key,
        body: file.buffer,
        contentType: file.mimetype,
        contentLength: file.size,
        metadata: {
          customername: dto.customerName,
          phonemasked: this.maskPhone(dto.phone),
          jobtype: dto.jobType,
        },
      });

      uploadedFiles.push({
        originalName: file.originalname,
        sanitizedName,
        mimeType: file.mimetype,
        size: file.size,
        s3Key,
      });
    }

    await this.uploadModel.create({
      uploadId,
      orderCode,
      customerName: dto.customerName,
      phone: dto.phone,
      note: dto.note,
      jobType: dto.jobType,
      files: uploadedFiles,
    });

    return {
      uploadId,
      orderCode,
      message: 'Upload success',
    };
  }

  private generateOrderCode(): string {
    const datePart = dayjs().format('YYYYMMDD');
    const serial = randomInt(1000, 10000);
    return `GL-${datePart}-${serial}`;
  }

  private maskPhone(phone: string): string {
    if (phone.length <= 4) {
      return '****';
    }

    return `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }
}
