import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UploadsController } from '../src/uploads/uploads.controller';
import { UploadsService } from '../src/uploads/uploads.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { JobType, UploadStage } from '../src/uploads/uploads.enums';

describe('UploadsController (e2e)', () => {
  let app: INestApplication;
  let server: Parameters<typeof request>[0];
  const createUpload = jest.fn().mockResolvedValue({
    id: 'mock-upload-id',
    uploadId: 'mock-upload-id',
    orderCode: 'GL-20260515-1234',
    originalName: 'sample.pdf',
    size: 16,
    mimeType: 'application/pdf',
    createdAt: '2026-05-31T00:00:00.000Z',
    message: 'Upload success',
  });
  const getSignedUrlById = jest.fn().mockResolvedValue({
    signedUrl: 'https://example.com/mock-signed-url',
    expiresIn: 300,
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        {
          provide: UploadsService,
          useValue: {
            createUpload,
            getSignedUrlById,
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    createUpload.mockClear();
    getSignedUrlById.mockClear();
  });

  it('POST /uploads success upload', async () => {
    await request(server)
      .post('/uploads')
      .field('customerName', 'Upload Customer')
      .field('phone', '0000000000')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .field(
        'note',
        '[[batch:4d6b9e89-52f6-4614-aa35-fc764f29f8cb]] [[stage:waiting-download]]',
      )
      .field('statusNote', 'Ready for pickup after download')
      .field('batchId', '4d6b9e89-52f6-4614-aa35-fc764f29f8cb')
      .field('stage', UploadStage.WAITING_DOWNLOAD)
      .attach('files', Buffer.from('fake pdf content'), 'sample.pdf')
      .expect(201)
      .expect({
        id: 'mock-upload-id',
        uploadId: 'mock-upload-id',
        orderCode: 'GL-20260515-1234',
        originalName: 'sample.pdf',
        size: 16,
        mimeType: 'application/pdf',
        createdAt: '2026-05-31T00:00:00.000Z',
        message: 'Upload success',
      });

    expect(createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: 'Upload Customer',
        phone: '0000000000',
        jobType: JobType.DOCUMENT_PRINTING,
        note: [
          '[[batch:4d6b9e89-52f6-4614-aa35-fc764f29f8cb]]',
          '[[stage:waiting-download]]',
        ].join(' '),
        statusNote: 'Ready for pickup after download',
        batchId: '4d6b9e89-52f6-4614-aa35-fc764f29f8cb',
        stage: UploadStage.WAITING_DOWNLOAD,
      }),
      expect.any(Array),
    );
  });

  it('POST /uploads invalid type', async () => {
    await request(server)
      .post('/uploads')
      .field('customerName', 'Alice')
      .field('phone', '0812345678')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .attach('files', Buffer.from('hello'), 'malware.exe')
      .expect(400)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toContain('Invalid file type');
      });
  });

  it('POST /uploads file too large', async () => {
    const tooLargeBuffer = Buffer.alloc(100 * 1024 * 1024 + 1, 'a');

    await request(server)
      .post('/uploads')
      .field('customerName', 'Alice')
      .field('phone', '0812345678')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .attach('files', tooLargeBuffer, 'huge.pdf')
      .expect(400)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toContain('File too large');
      });
  });

  it('GET /uploads/:id/signed-url returns signed url', async () => {
    await request(server)
      .get('/uploads/mock-upload-id/signed-url')
      .expect(200)
      .expect({
        signedUrl: 'https://example.com/mock-signed-url',
        expiresIn: 300,
      });

    expect(getSignedUrlById).toHaveBeenCalledWith('mock-upload-id');
  });

  it('POST /uploads missing files', async () => {
    await request(server)
      .post('/uploads')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .expect(400)
      .expect(({ body }: { body: { message: string } }) => {
        expect(body.message).toContain('At least one file is required');
      });
  });
});
