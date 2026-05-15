import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, isValidObjectId, Model } from 'mongoose';
import { randomInt, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadResponseDto } from './dto/upload-response.dto';
import { Upload, UploadDocument, UploadStatus } from './schemas/upload.schema';
import { S3Service } from './s3/s3.service';
import { sanitizeFilename } from './validators/upload-file.validator';
import { ListUploadsQueryDto } from './dto/list-uploads-query.dto';
import { UpdateUploadDto } from './dto/update-upload.dto';

const REGEX_SPECIAL_CHARS = new RegExp(String.raw`[.*+?^\${}()|[\]\\]`, 'g');

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
          // S3 metadata is transmitted via HTTP headers; keep values ASCII-safe.
          customername: this.toAsciiMetadata(dto.customerName),
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
      status: UploadStatus.PENDING,
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

  private toAsciiMetadata(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
  }

  async listUploads(query: ListUploadsQueryDto): Promise<{
    data: Array<Record<string, unknown>>;
    page: number;
    limit: number;
    total: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const filter: FilterQuery<UploadDocument> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.q?.trim()) {
      const safe = query.q.trim().replace(REGEX_SPECIAL_CHARS, '\\$&');
      filter.$or = [
        { customerName: { $regex: safe, $options: 'i' } },
        { phone: { $regex: safe, $options: 'i' } },
        { note: { $regex: safe, $options: 'i' } },
      ];
    }

    const [rows, total] = await Promise.all([
      this.uploadModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.uploadModel.countDocuments(filter),
    ]);

    const data = await Promise.all(rows.map((row) => this.toListItem(row)));
    return { data, page, limit, total };
  }

  async updateUploadById(
    id: string,
    dto: UpdateUploadDto,
  ): Promise<Record<string, unknown> | null> {
    const selector: FilterQuery<UploadDocument> = isValidObjectId(id)
      ? { $or: [{ uploadId: id }, { _id: id }] }
      : { uploadId: id };
    const row = await this.uploadModel
      .findOneAndUpdate(selector, { $set: dto }, { new: true })
      .lean();
    if (!row) {
      return null;
    }
    return this.toListItem(row);
  }

  async deleteUploadById(id: string): Promise<boolean> {
    const selector: FilterQuery<UploadDocument> = isValidObjectId(id)
      ? { $or: [{ uploadId: id }, { _id: id }] }
      : { uploadId: id };
    const row = await this.uploadModel.findOneAndDelete(selector);
    if (!row) {
      return false;
    }

    await Promise.all(
      row.files.map((file) => this.s3Service.deleteObject(file.s3Key)),
    );
    return true;
  }

  private async toListItem(
    row: UploadDocument | Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const doc = row as {
      _id: unknown;
      uploadId: string;
      customerName: string;
      phone: string;
      note?: string;
      jobType: string;
      status: string;
      createdAt: Date;
      files: Array<{
        s3Key: string;
        sanitizedName: string;
        originalName: string;
      }>;
    };

    const files = await Promise.all(
      (doc.files ?? []).map(async (file) => {
        let url: string | null = null;
        try {
          url = await this.s3Service.createSignedDownloadUrl(file.s3Key);
        } catch {
          url = null;
        }

        return {
          fileId: file.s3Key,
          name: file.originalName || file.sanitizedName,
          url,
        };
      }),
    );

    return {
      id: String(doc._id),
      uploadId: doc.uploadId,
      customerName: doc.customerName,
      phone: doc.phone,
      note: doc.note ?? '',
      category: doc.jobType,
      jobType: doc.jobType,
      status: doc.status,
      createdAt: doc.createdAt,
      files,
    };
  }
}
