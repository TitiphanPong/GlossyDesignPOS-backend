import { Model } from 'mongoose';
import { UploadsService } from './uploads.service';
import { JobType, UploadStage, UploadStatus } from './uploads.enums';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadDocument } from './schemas/upload.schema';
import { S3Service } from './s3/s3.service';

type UploadModelLike = {
  create: (doc: Record<string, unknown>) => Promise<unknown>;
};

type S3ServiceLike = {
  uploadPrivateObject: (
    params: Parameters<S3Service['uploadPrivateObject']>[0],
  ) => Promise<void>;
};

describe('UploadsService', () => {
  it('stores batchId, stage, and statusNote on create', async () => {
    const create: jest.MockedFunction<UploadModelLike['create']> = jest
      .fn()
      .mockResolvedValue(undefined);
    const uploadModel: UploadModelLike = { create };
    const uploadPrivateObject: jest.MockedFunction<
      S3ServiceLike['uploadPrivateObject']
    > = jest.fn().mockResolvedValue(undefined);
    const s3Service: S3ServiceLike = { uploadPrivateObject };

    const service = new UploadsService(
      uploadModel as unknown as Model<UploadDocument>,
      s3Service as unknown as S3Service,
    );
    const dto: CreateUploadDto = {
      customerName: 'Upload Customer',
      phone: '0000000000',
      jobType: JobType.DOCUMENT_PRINTING,
      note: [
        '[[batch:4d6b9e89-52f6-4614-aa35-fc764f29f8cb]]',
        '[[stage:waiting-download]]',
      ].join(' '),
      statusNote: 'Queued for download',
      batchId: '4d6b9e89-52f6-4614-aa35-fc764f29f8cb',
      stage: UploadStage.WAITING_DOWNLOAD,
    };
    const files = [
      {
        originalname: 'sample.pdf',
        mimetype: 'application/pdf',
        size: 12,
        buffer: Buffer.from('hello world'),
      },
    ] as Express.Multer.File[];

    await service.createUpload(dto, files);

    expect(uploadPrivateObject).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: dto.customerName,
        phone: dto.phone,
        jobType: dto.jobType,
        note: dto.note,
        statusNote: dto.statusNote,
        batchId: dto.batchId,
        stage: dto.stage,
        status: UploadStatus.PENDING,
        files: [
          expect.objectContaining({
            originalName: 'sample.pdf',
            sanitizedName: 'sample.pdf',
          }),
        ],
      }),
    );
  });
});
