import { Model, PipelineStage } from 'mongoose';
import { UploadsService } from './uploads.service';
import { JobType, UploadStage, UploadStatus } from './uploads.enums';
import {
  CreateUploadDto,
  VerifiedCreateUploadDto,
} from './dto/create-upload.dto';
import { UploadDocument } from './schemas/upload.schema';
import { OrderDocument } from '../orders/orders.schema';
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
  createSignedDownloadUrl?: (
    key: string,
    expiresInSeconds?: number,
  ) => Promise<string>;
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
    const createSignedDownloadUrl = jest
      .fn()
      .mockResolvedValue('https://signed/upload');
    const s3Service: S3ServiceLike = {
      uploadPrivateObject,
      createSignedDownloadUrl,
    };

    const service = new UploadsService(
      uploadModel as unknown as Model<UploadDocument>,
      s3Service as unknown as S3Service,
      createNotificationsService(),
      {} as Model<OrderDocument>,
    );
    const dto: VerifiedCreateUploadDto = {
      customerName: 'Upload Customer',
      phone: '0000000000',
      lineUserId: 'Uupload123',
      displayName: 'Upload LINE',
      linePictureUrl: 'https://profile.line-scdn.net/upload',
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

    const result = await service.createUpload(dto, files);

    expect(uploadPrivateObject).toHaveBeenCalledTimes(1);
    expect(createSignedDownloadUrl).toHaveBeenCalledWith(
      expect.stringMatching(/\/sample\.pdf$/u),
      900,
    );
    expect(result.signedUrl).toBe('https://signed/upload');
    expect(result.expiresIn).toBe(900);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: dto.customerName,
        phone: dto.phone,
        lineUserId: dto.lineUserId,
        displayName: dto.displayName,
        linePictureUrl: dto.linePictureUrl,
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

  it('cleans up uploaded objects when immediate preview signing fails before Mongo persistence', async () => {
    const create = jest.fn();
    const uploadPrivateObject = jest.fn().mockResolvedValue(undefined);
    const createSignedDownloadUrl = jest
      .fn()
      .mockRejectedValue(new Error('signing unavailable'));
    const deleteObject = jest.fn().mockResolvedValue(undefined);
    const service = new UploadsService(
      { create } as unknown as Model<UploadDocument>,
      {
        uploadPrivateObject,
        createSignedDownloadUrl,
        deleteObject,
      } as unknown as S3Service,
      createNotificationsService(),
      {} as Model<OrderDocument>,
    );
    const dto: CreateUploadDto = {
      customerName: 'Upload Customer',
      phone: '0000000000',
      jobType: JobType.DOCUMENT_PRINTING,
    };
    const files = [
      {
        originalname: 'sample.pdf',
        mimetype: 'application/pdf',
        size: 12,
        buffer: Buffer.from('hello world'),
      },
    ] as Express.Multer.File[];

    await expect(service.createUpload(dto, files)).rejects.toThrow(
      'signing unavailable',
    );

    expect(create).not.toHaveBeenCalled();
    expect(deleteObject).toHaveBeenCalledTimes(1);
  });

  it('removes already-uploaded S3 objects when Mongo persistence fails', async () => {
    const create = jest.fn().mockRejectedValue(new Error('mongo unavailable'));
    const uploadPrivateObject = jest.fn().mockResolvedValue(undefined);
    const createSignedDownloadUrl = jest
      .fn()
      .mockResolvedValue('https://signed/upload');
    const deleteObject: jest.MockedFunction<(key: string) => Promise<void>> =
      jest.fn().mockResolvedValue(undefined);
    const service = new UploadsService(
      { create } as unknown as Model<UploadDocument>,
      {
        uploadPrivateObject,
        createSignedDownloadUrl,
        deleteObject,
      } as unknown as S3Service,
      createNotificationsService(),
      {} as Model<OrderDocument>,
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
      {} as Model<OrderDocument>,
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
      {} as Model<OrderDocument>,
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
            displayName: 'Alpha LINE',
            lineUserId: 'Ualpha123',
            linePictureUrl: 'https://profile.line-scdn.net/alpha',
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
      {} as Model<OrderDocument>,
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
        displayName: 'Alpha LINE',
        lineUserId: 'Ualpha123',
        linePictureUrl: 'https://profile.line-scdn.net/alpha',
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
    expect(serializedPipeline).toContain('"displayName"');
    expect(serializedPipeline).toContain('"lineUserId"');
    expect(serializedPipeline).toContain('"$skip":3');
    expect(serializedPipeline).toContain('"$limit":3');
  });

  it('retries a duplicate intake code without deleting uploaded S3 objects', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce({ code: 11000, keyPattern: { orderCode: 1 } })
      .mockImplementationOnce((record: Record<string, unknown>) =>
        Promise.resolve({ ...record, _id: '61a1c287e53a7024d4ab8142' }),
      );
    const deleteObject = jest.fn().mockResolvedValue(undefined);
    const service = new UploadsService(
      { create } as unknown as Model<UploadDocument>,
      {
        uploadPrivateObject: jest.fn().mockResolvedValue(undefined),
        createSignedDownloadUrl: jest
          .fn()
          .mockResolvedValue('https://signed/upload'),
        deleteObject,
      } as unknown as S3Service,
      createNotificationsService(),
      {} as Model<OrderDocument>,
    );

    const result = await service.createUpload({ jobType: JobType.OTHER }, [
      {
        originalname: 'sample.pdf',
        mimetype: 'application/pdf',
        size: 12,
        buffer: Buffer.from('hello world'),
      },
    ] as Express.Multer.File[]);

    expect(create).toHaveBeenCalledTimes(2);
    expect(result.orderCode).toMatch(/^GL-\d{8}-[A-F0-9]{8}$/u);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('links and unlinks existing uploads through an Order relation', async () => {
    const uploadRows = new Map([
      [
        '4d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        {
          _id: '61a1c287e53a7024d4ab8142',
          uploadId: '4d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        },
      ],
      [
        '5d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        {
          _id: '61a1c287e53a7024d4ab8143',
          uploadId: '5d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        },
      ],
    ]);
    const findOne = jest.fn((selector: Record<string, unknown>) => ({
      select: jest.fn().mockReturnThis(),
      lean: jest
        .fn()
        .mockResolvedValue(uploadRows.get(String(selector.uploadId)) ?? null),
    }));
    const updateMany = jest.fn().mockResolvedValue({ modifiedCount: 2 });
    const orderModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: '71a1c287e53a7024d4ab8142',
          orderId: '0101',
          orderNumber: 'ORD-0101',
        }),
      }),
    };
    const service = new UploadsService(
      { findOne, updateMany } as unknown as Model<UploadDocument>,
      {} as S3Service,
      createNotificationsService(),
      orderModel as unknown as Model<OrderDocument>,
    );

    await expect(
      service.linkUploadsToOrder(
        [
          '4d6b9e89-52f6-4614-aa35-fc764f29f8cb',
          '5d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        ],
        'ORD-0101',
      ),
    ).resolves.toEqual({
      uploadIds: [
        '4d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        '5d6b9e89-52f6-4614-aa35-fc764f29f8cb',
      ],
      linkedOrderId: '71a1c287e53a7024d4ab8142',
      linkedOrderNumber: 'ORD-0101',
    });
    expect(updateMany).toHaveBeenLastCalledWith(
      {
        _id: { $in: ['61a1c287e53a7024d4ab8142', '61a1c287e53a7024d4ab8143'] },
      },
      {
        $set: {
          linkedOrderId: '71a1c287e53a7024d4ab8142',
          linkedOrderNumber: 'ORD-0101',
        },
      },
    );

    await service.linkUploadsToOrder(
      [
        '4d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        '5d6b9e89-52f6-4614-aa35-fc764f29f8cb',
      ],
      null,
    );
    expect(updateMany).toHaveBeenLastCalledWith(
      {
        _id: { $in: ['61a1c287e53a7024d4ab8142', '61a1c287e53a7024d4ab8143'] },
      },
      { $unset: { linkedOrderId: 1, linkedOrderNumber: 1 } },
    );
  });
});
