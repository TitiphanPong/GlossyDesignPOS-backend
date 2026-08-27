import { Model, PipelineStage } from 'mongoose';
import { UploadsService } from './uploads.service';
import { JobType, UploadStage, UploadStatus } from './uploads.enums';
import { CreateUploadDto } from './dto/create-upload.dto';
import { UploadDocument } from './schemas/upload.schema';
import { S3Service } from './s3/s3.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  StorageListSort,
  StorageListStatus,
} from './dto/list-uploads-query.dto';

type UploadModelLike = {
  create: (doc: Record<string, unknown>) => Promise<unknown>;
  findOne?: (filter: Record<string, unknown>) => {
    exec: () => Promise<unknown>;
  };
  findOneAndDelete?: (filter: Record<string, unknown>) => {
    exec: () => Promise<unknown>;
  };
};

type S3ServiceLike = {
  uploadPrivateObject: (
    params: Parameters<S3Service['uploadPrivateObject']>[0],
  ) => Promise<void>;
  deleteObject?: (key: string) => Promise<void>;
};

function createNotificationsService(): NotificationsService {
  return {
    handleUploadReview: jest.fn().mockResolvedValue(undefined),
    autoResolveUploadNotifications: jest.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;
}

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
      createNotificationsService(),
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

  it('removes already-uploaded S3 objects when Mongo persistence fails', async () => {
    const create = jest.fn().mockRejectedValue(new Error('mongo unavailable'));
    const uploadPrivateObject = jest.fn().mockResolvedValue(undefined);
    const deleteObject: jest.MockedFunction<(key: string) => Promise<void>> =
      jest.fn().mockResolvedValue(undefined);
    const service = new UploadsService(
      { create } as unknown as Model<UploadDocument>,
      { uploadPrivateObject, deleteObject } as unknown as S3Service,
      createNotificationsService(),
    );
    const dto: CreateUploadDto = {
      customerName: 'Upload Customer',
      phone: '0000000000',
      jobType: JobType.DOCUMENT_PRINTING,
    };
    const files = [
      {
        originalname: 'one.pdf',
        mimetype: 'application/pdf',
        size: 3,
        buffer: Buffer.from('one'),
      },
      {
        originalname: 'two.pdf',
        mimetype: 'application/pdf',
        size: 3,
        buffer: Buffer.from('two'),
      },
    ] as Express.Multer.File[];

    await expect(service.createUpload(dto, files)).rejects.toThrow(
      'mongo unavailable',
    );

    expect(uploadPrivateObject).toHaveBeenCalledTimes(2);
    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(deleteObject.mock.calls[0]?.[0]).toMatch(/\/one\.pdf$/u);
    expect(deleteObject.mock.calls[1]?.[0]).toMatch(/\/two\.pdf$/u);
  });

  it('keeps the Mongo reference when an S3 delete fails so deletion can be retried', async () => {
    const row = {
      _id: '61a1c287e53a7024d4ab8142',
      files: [{ s3Key: 'uploads/a.pdf' }, { s3Key: 'uploads/b.pdf' }],
    };
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(row),
    });
    const findOneAndDelete = jest.fn();
    const deleteObject = jest
      .fn()
      .mockRejectedValueOnce(new Error('s3 unavailable'))
      .mockResolvedValue(undefined);
    const service = new UploadsService(
      {
        create: jest.fn(),
        findOne,
        findOneAndDelete,
      } as unknown as Model<UploadDocument>,
      {
        uploadPrivateObject: jest.fn(),
        deleteObject,
      } as unknown as S3Service,
      createNotificationsService(),
    );

    await expect(
      service.deleteUploadById('61a1c287e53a7024d4ab8142'),
    ).rejects.toThrow('s3 unavailable');

    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(findOneAndDelete).not.toHaveBeenCalled();
  });

  it('deletes the Mongo record only after all S3 objects are deleted', async () => {
    const row = {
      _id: '61a1c287e53a7024d4ab8142',
      files: [{ s3Key: 'uploads/a.pdf' }, { s3Key: 'uploads/b.pdf' }],
    };
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(row),
    });
    const deleteExec = jest.fn().mockResolvedValue(row);
    const findOneAndDelete = jest.fn().mockReturnValue({ exec: deleteExec });
    const deleteObject = jest.fn().mockResolvedValue(undefined);
    const service = new UploadsService(
      {
        create: jest.fn(),
        findOne,
        findOneAndDelete,
      } as unknown as Model<UploadDocument>,
      {
        uploadPrivateObject: jest.fn(),
        deleteObject,
      } as unknown as S3Service,
      createNotificationsService(),
    );

    await expect(
      service.deleteUploadById('61a1c287e53a7024d4ab8142'),
    ).resolves.toBe(true);

    expect(deleteObject).toHaveBeenCalledTimes(2);
    expect(findOneAndDelete).toHaveBeenCalledWith({ _id: row._id });
    expect(deleteExec).toHaveBeenCalledTimes(1);
  });

  it('groups and filters the full upload result before pagination', async () => {
    const exec = jest.fn().mockResolvedValue([
      {
        data: [
          {
            _id: '61a1c287e53a7024d4ab8142',
            uploadId: 'upload-1',
            sourceIds: ['upload-1', 'upload-2'],
            orderCode: 'GL-20260827-1001',
            customerName: 'Alpha',
            phone: '0812345678',
            jobType: JobType.OTHER,
            status: UploadStatus.PENDING,
            storageStatus: StorageListStatus.WAITING,
            createdAt: new Date('2026-08-27T02:00:00.000Z'),
            files: [
              {
                s3Key: 'uploads/a.pdf',
                originalName: 'a.pdf',
                sanitizedName: 'a.pdf',
              },
              {
                s3Key: 'uploads/b.pdf',
                originalName: 'b.pdf',
                sanitizedName: 'b.pdf',
              },
            ],
          },
        ],
        total: [{ value: 7 }],
        summary: [
          {
            waiting: 3,
            pending: 2,
            completed: 2,
            totalFiles: 11,
            uploadedToday: 4,
          },
        ],
      },
    ]);
    const aggregate: jest.MockedFunction<
      (pipeline: PipelineStage[]) => { exec: typeof exec }
    > = jest.fn().mockReturnValue({ exec });
    const createSignedDownloadUrl = jest
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(`https://signed/${key}`),
      );
    const service = new UploadsService(
      { aggregate } as unknown as Model<UploadDocument>,
      {
        uploadPrivateObject: jest.fn(),
        createSignedDownloadUrl,
      } as unknown as S3Service,
      createNotificationsService(),
    );

    const result = await service.listUploads({
      page: 2,
      limit: 3,
      storageStatus: StorageListStatus.WAITING,
      date: '2026-08-27',
      sort: StorageListSort.OLDEST,
      q: 'Alpha',
    });

    expect(result.total).toBe(7);
    expect(result.summary).toEqual({
      waiting: 3,
      pending: 2,
      completed: 2,
      totalFiles: 11,
      uploadedToday: 4,
    });
    expect(result.data[0]).toEqual(
      expect.objectContaining({
        uploadId: 'upload-1',
        sourceIds: ['upload-1', 'upload-2'],
        storageStatus: StorageListStatus.WAITING,
      }),
    );
    expect(createSignedDownloadUrl).toHaveBeenCalledTimes(2);

    const pipeline = aggregate.mock.calls[0]?.[0];
    expect(pipeline).toBeDefined();
    if (!pipeline) throw new Error('Expected aggregation pipeline');

    const stageNames = pipeline.map((stage) => Object.keys(stage)[0]);
    const groupIndex = stageNames.indexOf('$group');
    const facetIndex = stageNames.indexOf('$facet');
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(facetIndex).toBeGreaterThan(groupIndex);

    const serializedPipeline = JSON.stringify(pipeline);
    expect(serializedPipeline).toContain('"storageStatus":"waiting"');
    expect(serializedPipeline).toContain('"$gte"');
    expect(serializedPipeline).toContain('"$lt"');
    expect(serializedPipeline).toContain('"$or"');
    expect(serializedPipeline).toContain('"$skip":3');
    expect(serializedPipeline).toContain('"$limit":3');
  });
});
