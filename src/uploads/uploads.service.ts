import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, isValidObjectId, Model, PipelineStage } from 'mongoose';
import { randomBytes, randomUUID } from 'node:crypto';
import dayjs from 'dayjs';
import { VerifiedCreateUploadDto } from './dto/create-upload.dto';
import { UploadResponseDto } from './dto/upload-response.dto';
import { Upload, UploadDocument } from './schemas/upload.schema';
import { S3Service } from './s3/s3.service';
import { sanitizeFilename } from './validators/upload-file.validator';
import {
  ListUploadsQueryDto,
  StorageListSort,
  StorageListStatus,
  UploadLinkStatus,
} from './dto/list-uploads-query.dto';
import { UpdateUploadDto } from './dto/update-upload.dto';
import { UploadStage, UploadStatus } from './uploads.enums';
import { NotificationsService } from '../notifications/notifications.service';
import { Order, OrderDocument } from '../orders/orders.schema';

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_UPLOAD_PREVIEW_TTL_SECONDS = 15 * 60;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    @InjectModel(Upload.name)
    private readonly uploadModel: Model<UploadDocument>,
    private readonly s3Service: S3Service,
    private readonly notificationsService: NotificationsService,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
  ) {}

  async createUpload(
    dto: VerifiedCreateUploadDto,
    files: Express.Multer.File[],
  ): Promise<UploadResponseDto> {
    const uploadId = randomUUID();
    let orderCode = '';
    const now = new Date();
    const yyyy = dayjs(now).format('YYYY');
    const mm = dayjs(now).format('MM');

    const uploadedFiles: Upload['files'] = [];
    let savedUpload: UploadDocument | null = null;
    let previewSignedUrl = '';

    try {
      for (const file of files) {
        const sanitizedName = sanitizeFilename(file.originalname);
        const s3Key = `uploads/${yyyy}/${mm}/${uploadId}/${sanitizedName}`;

        await this.s3Service.uploadPrivateObject({
          key: s3Key,
          body: file.buffer,
          contentType: file.mimetype,
          contentLength: file.size,
          metadata: this.buildUploadMetadata(dto),
        });

        uploadedFiles.push({
          originalName: file.originalname,
          sanitizedName,
          mimeType: file.mimetype,
          size: file.size,
          s3Key,
        });
      }

      const previewFile = uploadedFiles[0];
      if (!previewFile) {
        throw new BadRequestException('At least one file is required');
      }
      previewSignedUrl = await this.s3Service.createSignedDownloadUrl(
        previewFile.s3Key,
        PUBLIC_UPLOAD_PREVIEW_TTL_SECONDS,
      );

      const created = await this.createUploadRecordWithUniqueCode({
        uploadId,
        customerName: dto.customerName,
        phone: dto.phone,
        lineUserId: dto.lineUserId,
        displayName: dto.displayName,
        category: dto.category,
        note: dto.note,
        statusNote: dto.statusNote,
        batchId: dto.batchId,
        stage: dto.stage,
        jobType: dto.jobType,
        status: UploadStatus.PENDING,
        files: uploadedFiles,
      });
      savedUpload = created.savedUpload;
      orderCode = created.orderCode;
    } catch (error) {
      await this.cleanupUploadedObjects(
        uploadedFiles.map((file) => file.s3Key),
      );
      throw error;
    }

    if (savedUpload) {
      try {
        await this.notificationsService.handleUploadReview(savedUpload);
      } catch (error) {
        this.logger.error(
          'Failed to create action-center item for upload',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    const firstFile = uploadedFiles[0];

    return {
      id: uploadId,
      uploadId,
      orderCode,
      originalName: firstFile?.originalName ?? '',
      size: firstFile?.size ?? 0,
      mimeType: firstFile?.mimeType ?? 'application/octet-stream',
      createdAt: now.toISOString(),
      signedUrl: previewSignedUrl,
      expiresIn: PUBLIC_UPLOAD_PREVIEW_TTL_SECONDS,
      message: 'Upload success',
    };
  }

  async getSignedUrlById(
    id: string,
  ): Promise<{ signedUrl: string; expiresIn: number } | null> {
    const selector = this.selectorForUploadId(id);
    const row = await this.uploadModel.findOne(selector).lean();
    const firstFile = row?.files?.[0];
    if (!firstFile) {
      return null;
    }

    const expiresIn = 300;
    const signedUrl = await this.s3Service.createSignedDownloadUrl(
      firstFile.s3Key,
      expiresIn,
    );
    return { signedUrl, expiresIn };
  }

  private generateIntakeCode(): string {
    const datePart = dayjs().format('YYYYMMDD');
    const serial = randomBytes(4).toString('hex').toUpperCase();
    return `GL-${datePart}-${serial}`;
  }

  private async createUploadRecordWithUniqueCode(
    record: Omit<Partial<Upload>, 'orderCode'> &
      Pick<Upload, 'uploadId' | 'jobType' | 'status' | 'files'>,
  ): Promise<{ savedUpload: UploadDocument; orderCode: string }> {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const orderCode = this.generateIntakeCode();
      try {
        const savedUpload = await this.uploadModel.create({
          ...record,
          orderCode,
        });
        return { savedUpload, orderCode };
      } catch (error) {
        const mongoError = error as {
          code?: number;
          keyPattern?: Record<string, unknown>;
        };
        const duplicateCode =
          mongoError?.code === 11000 &&
          Boolean(mongoError.keyPattern?.orderCode);
        if (!duplicateCode) throw error;
        if (attempt === maxAttempts) {
          throw new InternalServerErrorException(
            'Failed to allocate upload intake code.',
          );
        }
      }
    }

    throw new InternalServerErrorException(
      'Failed to allocate upload intake code.',
    );
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

  private buildUploadMetadata(
    dto: VerifiedCreateUploadDto,
  ): Record<string, string> {
    const metadata: Record<string, string> = {
      jobtype: dto.jobType,
    };

    if (dto.customerName?.trim()) {
      // S3 metadata is transmitted via HTTP headers; keep values ASCII-safe.
      metadata.customername = this.toAsciiMetadata(dto.customerName.trim());
    }

    if (dto.phone?.trim()) {
      metadata.phonemasked = this.maskPhone(dto.phone.trim());
    }

    return metadata;
  }

  async listUploads(query: ListUploadsQueryDto): Promise<{
    data: Array<Record<string, unknown>>;
    page: number;
    limit: number;
    total: number;
    summary: {
      waiting: number;
      pending: number;
      completed: number;
      totalFiles: number;
      uploadedToday: number;
    };
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;
    const todayKey = new Date(Date.now() + BANGKOK_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
    const todayRange = this.getBangkokDayRange(todayKey);

    const pipeline: PipelineStage[] = [];
    if (query.status) {
      pipeline.push({ $match: { status: query.status } });
    }

    pipeline.push(
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $set: {
          __storageStatus: {
            $switch: {
              branches: [
                {
                  case: {
                    $or: [
                      { $eq: ['$status', UploadStatus.COMPLETED] },
                      { $eq: ['$stage', UploadStage.COMPLETED] },
                    ],
                  },
                  then: StorageListStatus.COMPLETED,
                },
                {
                  case: { $eq: ['$stage', UploadStage.PENDING] },
                  then: StorageListStatus.PENDING,
                },
              ],
              default: StorageListStatus.WAITING,
            },
          },
          __batchMarker: {
            $regexFind: {
              input: { $ifNull: ['$note', ''] },
              regex: /\[\[batch:([a-z0-9-]+)\]\]/i,
            },
          },
        },
      },
      {
        $set: {
          __resolvedBatchId: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ['$batchId', ''] } }, 0] },
              '$batchId',
              { $arrayElemAt: ['$__batchMarker.captures', 0] },
            ],
          },
        },
      },
      {
        $set: {
          __groupKey: {
            $cond: [
              {
                $gt: [
                  { $strLenCP: { $ifNull: ['$__resolvedBatchId', ''] } },
                  0,
                ],
              },
              { $concat: ['batch:', '$__resolvedBatchId'] },
              { $concat: ['single:', '$uploadId'] },
            ],
          },
        },
      },
      {
        $group: {
          _id: '$__groupKey',
          representativeId: { $first: '$_id' },
          uploadId: { $first: '$uploadId' },
          sourceIds: { $addToSet: '$uploadId' },
          orderCode: { $first: '$orderCode' },
          customerName: { $first: '$customerName' },
          phone: { $first: '$phone' },
          lineUserId: { $first: '$lineUserId' },
          displayName: { $first: '$displayName' },
          category: { $first: '$category' },
          note: { $first: '$note' },
          statusNote: { $first: '$statusNote' },
          batchId: { $first: '$__resolvedBatchId' },
          linkedOrderId: { $first: '$linkedOrderId' },
          linkedOrderNumber: { $first: '$linkedOrderNumber' },
          stage: { $first: '$stage' },
          jobType: { $first: '$jobType' },
          status: { $first: '$status' },
          storageStatus: { $first: '$__storageStatus' },
          createdAt: { $min: '$createdAt' },
          filesNested: { $push: '$files' },
        },
      },
      {
        $set: {
          _id: '$representativeId',
          files: {
            $reduce: {
              input: '$filesNested',
              initialValue: [],
              in: {
                $concatArrays: ['$$value', { $ifNull: ['$$this', []] }],
              },
            },
          },
        },
      },
    );

    const groupedMatch: Record<string, unknown> = {};
    const groupedAnd: Record<string, unknown>[] = [];
    if (query.storageStatus) groupedMatch.storageStatus = query.storageStatus;
    if (query.jobType) groupedMatch.jobType = query.jobType;
    if (query.linkStatus === UploadLinkStatus.LINKED) {
      groupedMatch.linkedOrderId = { $nin: [null, ''] };
    }
    if (query.linkStatus === UploadLinkStatus.UNLINKED) {
      groupedAnd.push({
        $or: [
          { linkedOrderId: { $exists: false } },
          { linkedOrderId: null },
          { linkedOrderId: '' },
        ],
      });
    }
    if (query.orderReference?.trim()) {
      const reference = query.orderReference.trim();
      groupedAnd.push({
        $or: [{ linkedOrderId: reference }, { linkedOrderNumber: reference }],
      });
    }
    if (query.date) {
      const dateRange = this.getBangkokDayRange(query.date);
      groupedMatch.createdAt = { $gte: dateRange.start, $lt: dateRange.end };
    }
    if (query.q?.trim()) {
      const safe = query.q.trim().replace(REGEX_SPECIAL_CHARS, String.raw`\$&`);
      groupedAnd.push({
        $or: [
          { uploadId: { $regex: safe, $options: 'i' } },
          { sourceIds: { $regex: safe, $options: 'i' } },
          { orderCode: { $regex: safe, $options: 'i' } },
          { linkedOrderNumber: { $regex: safe, $options: 'i' } },
          { customerName: { $regex: safe, $options: 'i' } },
          { phone: { $regex: safe, $options: 'i' } },
          { jobType: { $regex: safe, $options: 'i' } },
          { category: { $regex: safe, $options: 'i' } },
          { note: { $regex: safe, $options: 'i' } },
          { statusNote: { $regex: safe, $options: 'i' } },
        ],
      });
    }
    if (groupedAnd.length > 0) groupedMatch.$and = groupedAnd;
    if (Object.keys(groupedMatch).length > 0) {
      pipeline.push({ $match: groupedMatch });
    }

    let sort: PipelineStage.Sort['$sort'];
    switch (query.sort ?? StorageListSort.NEWEST) {
      case StorageListSort.OLDEST:
        sort = { createdAt: 1, _id: 1 };
        break;
      case StorageListSort.CUSTOMER:
        sort = { customerName: 1, createdAt: -1 };
        break;
      case StorageListSort.STATUS:
        sort = { storageStatus: 1, createdAt: -1 };
        break;
      case StorageListSort.NEWEST:
      default:
        sort = { createdAt: -1, _id: -1 };
        break;
    }

    pipeline.push({
      $facet: {
        data: [{ $sort: sort }, { $skip: skip }, { $limit: limit }],
        total: [{ $count: 'value' }],
        summary: [
          {
            $group: {
              _id: null,
              waiting: {
                $sum: {
                  $cond: [
                    { $eq: ['$storageStatus', StorageListStatus.WAITING] },
                    1,
                    0,
                  ],
                },
              },
              pending: {
                $sum: {
                  $cond: [
                    { $eq: ['$storageStatus', StorageListStatus.PENDING] },
                    1,
                    0,
                  ],
                },
              },
              completed: {
                $sum: {
                  $cond: [
                    { $eq: ['$storageStatus', StorageListStatus.COMPLETED] },
                    1,
                    0,
                  ],
                },
              },
              totalFiles: {
                $sum: { $size: { $ifNull: ['$files', []] } },
              },
              uploadedToday: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $gte: ['$createdAt', todayRange.start] },
                        { $lt: ['$createdAt', todayRange.end] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
      },
    });

    type FacetResult = {
      data?: Array<Record<string, unknown>>;
      total?: Array<{ value: number }>;
      summary?: Array<{
        waiting: number;
        pending: number;
        completed: number;
        totalFiles: number;
        uploadedToday: number;
      }>;
    };
    const [result] = await this.uploadModel
      .aggregate<FacetResult>(pipeline)
      .exec();
    const rows = result?.data ?? [];
    const total = result?.total?.[0]?.value ?? 0;
    const summary = result?.summary?.[0] ?? {
      waiting: 0,
      pending: 0,
      completed: 0,
      totalFiles: 0,
      uploadedToday: 0,
    };
    const data = await Promise.all(rows.map((row) => this.toListItem(row)));

    return { data, page, limit, total, summary };
  }

  async updateUploadById(
    id: string,
    dto: UpdateUploadDto,
  ): Promise<Record<string, unknown> | null> {
    const selector = this.selectorForUploadId(id);
    const row = await this.uploadModel
      .findOneAndUpdate(selector, { $set: dto }, { new: true })
      .lean();
    if (!row) {
      return null;
    }

    if (
      row.uploadId &&
      (row.status === UploadStatus.COMPLETED ||
        row.stage === UploadStage.PENDING ||
        row.stage === UploadStage.COMPLETED)
    ) {
      try {
        await this.notificationsService.autoResolveUploadNotifications(
          row.uploadId,
        );
      } catch (error) {
        this.logger.error(
          'Failed to resolve action-center item for upload',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return this.toListItem(row);
  }

  async linkUploadsToOrder(
    uploadIds: string[],
    orderReference?: string | null,
  ): Promise<{
    uploadIds: string[];
    linkedOrderId: string | null;
    linkedOrderNumber: string | null;
  }> {
    const normalizedIds = Array.from(
      new Set(uploadIds.map((value) => value.trim()).filter(Boolean)),
    );
    if (normalizedIds.length === 0) {
      throw new BadRequestException('At least one upload id is required.');
    }

    let linkedOrderId: string | null = null;
    let linkedOrderNumber: string | null = null;
    const reference = orderReference?.trim();
    if (reference) {
      const orderSelector = isValidObjectId(reference)
        ? {
            $or: [
              { _id: reference },
              { orderId: reference },
              { orderNumber: reference },
            ],
          }
        : { $or: [{ orderId: reference }, { orderNumber: reference }] };
      const order = await this.orderModel
        .findOne(orderSelector)
        .select('_id orderId orderNumber')
        .lean();
      if (!order) {
        throw new NotFoundException('Order not found.');
      }
      linkedOrderId = String(order._id);
      linkedOrderNumber = order.orderNumber ?? order.orderId ?? linkedOrderId;
    }

    const rows = await Promise.all(
      normalizedIds.map((id) =>
        this.uploadModel
          .findOne(this.selectorForUploadId(id))
          .select('_id uploadId')
          .lean(),
      ),
    );
    if (rows.some((row) => !row)) {
      throw new NotFoundException('One or more uploads were not found.');
    }

    const objectIds = rows.map((row) => row!._id);
    if (linkedOrderId) {
      await this.uploadModel.updateMany(
        { _id: { $in: objectIds } },
        { $set: { linkedOrderId, linkedOrderNumber } },
      );
    } else {
      await this.uploadModel.updateMany(
        { _id: { $in: objectIds } },
        { $unset: { linkedOrderId: 1, linkedOrderNumber: 1 } },
      );
    }

    return { uploadIds: normalizedIds, linkedOrderId, linkedOrderNumber };
  }

  async deleteUploadById(id: string): Promise<boolean> {
    const selector = this.selectorForUploadId(id);
    const row = await this.uploadModel.findOne(selector).exec();
    if (!row) {
      return false;
    }

    // S3 DeleteObject is idempotent. Keep the Mongo record until every known
    // object deletion succeeds so a failed request can be retried safely.
    await Promise.all(
      row.files.map((file) => this.s3Service.deleteObject(file.s3Key)),
    );

    const deleted = await this.uploadModel
      .findOneAndDelete({ _id: row._id })
      .exec();
    if (deleted && row.uploadId) {
      try {
        await this.notificationsService.autoResolveUploadNotifications(
          row.uploadId,
        );
      } catch (error) {
        this.logger.error(
          'Failed to resolve action-center item after upload deletion',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return Boolean(deleted);
  }

  private async cleanupUploadedObjects(keys: string[]): Promise<void> {
    const results = await Promise.allSettled(
      keys.map((key) => this.s3Service.deleteObject(key)),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(
          `Failed to compensate uploaded S3 object ${keys[index]}`,
          result.reason instanceof Error
            ? result.reason.stack
            : String(result.reason),
        );
      }
    });
  }

  private getBangkokDayRange(dateText: string): { start: Date; end: Date } {
    const start = new Date(`${dateText}T00:00:00+07:00`);
    const normalizedDate = new Date(start.getTime() + BANGKOK_OFFSET_MS)
      .toISOString()
      .slice(0, 10);
    if (Number.isNaN(start.getTime()) || normalizedDate !== dateText) {
      throw new BadRequestException('Invalid upload date filter.');
    }

    return { start, end: new Date(start.getTime() + DAY_MS) };
  }

  private selectorForUploadId(id: string): FilterQuery<UploadDocument> {
    if (isValidObjectId(id)) {
      return { $or: [{ uploadId: id }, { _id: id }] };
    }

    if (UUID_PATTERN.test(id)) {
      return { uploadId: id };
    }

    throw new BadRequestException('Invalid upload id.');
  }

  private async toListItem(
    row: UploadDocument | Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const doc = row as {
      _id: unknown;
      uploadId: string;
      sourceIds?: string[];
      orderCode?: string;
      customerName?: string;
      phone?: string;
      lineUserId?: string;
      displayName?: string;
      category?: string;
      note?: string;
      statusNote?: string;
      batchId?: string;
      linkedOrderId?: string;
      linkedOrderNumber?: string;
      stage?: string;
      jobType: string;
      status: string;
      storageStatus?: string;
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
          downloadUrl: url,
          previewUrl: url,
          mimeType: (file as { mimeType?: string }).mimeType,
          size: (file as { size?: number }).size,
        };
      }),
    );

    return {
      id: String(doc._id),
      uploadId: doc.uploadId,
      sourceIds: doc.sourceIds?.filter((value) => Boolean(value)) ?? [
        doc.uploadId,
      ],
      orderCode: doc.orderCode ?? '',
      customerName: doc.customerName ?? '',
      phone: doc.phone ?? '',
      lineUserId: doc.lineUserId ?? '',
      displayName: doc.displayName ?? '',
      note: doc.note ?? '',
      statusNote: doc.statusNote ?? '',
      batchId: doc.batchId ?? null,
      linkedOrderId: doc.linkedOrderId ?? null,
      linkedOrderNumber: doc.linkedOrderNumber ?? null,
      stage: doc.stage ?? null,
      category: doc.category ?? doc.jobType,
      jobType: doc.jobType,
      status: doc.status,
      storageStatus: doc.storageStatus ?? null,
      createdAt: doc.createdAt,
      files,
    };
  }
}
