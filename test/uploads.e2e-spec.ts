import { ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { UploadsController } from '../src/uploads/uploads.controller';
import { UploadsService } from '../src/uploads/uploads.service';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { JobType } from '../src/uploads/dto/create-upload.dto';

describe('UploadsController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [UploadsController],
      providers: [
        {
          provide: UploadsService,
          useValue: {
            createUpload: jest.fn().mockResolvedValue({
              uploadId: 'mock-upload-id',
              orderCode: 'GL-20260515-1234',
              message: 'Upload success',
            }),
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
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /uploads success upload', async () => {
    await request(app.getHttpServer())
      .post('/uploads')
      .field('customerName', 'Alice')
      .field('phone', '0812345678')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .attach('files', Buffer.from('fake pdf content'), 'sample.pdf')
      .expect(201)
      .expect({
        uploadId: 'mock-upload-id',
        orderCode: 'GL-20260515-1234',
        message: 'Upload success',
      });
  });

  it('POST /uploads invalid type', async () => {
    await request(app.getHttpServer())
      .post('/uploads')
      .field('customerName', 'Alice')
      .field('phone', '0812345678')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .attach('files', Buffer.from('hello'), 'malware.exe')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('Invalid file type');
      });
  });

  it('POST /uploads file too large', async () => {
    const tooLargeBuffer = Buffer.alloc(100 * 1024 * 1024 + 1, 'a');

    await request(app.getHttpServer())
      .post('/uploads')
      .field('customerName', 'Alice')
      .field('phone', '0812345678')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .attach('files', tooLargeBuffer, 'huge.pdf')
      .expect(400)
      .expect(({ body }) => {
        expect(body.message).toContain('File too large');
      });
  });

  it('POST /uploads missing required field', async () => {
    await request(app.getHttpServer())
      .post('/uploads')
      .field('customerName', 'Alice')
      .field('jobType', JobType.DOCUMENT_PRINTING)
      .attach('files', Buffer.from('fake pdf content'), 'sample.pdf')
      .expect(400)
      .expect(({ body }) => {
        expect(Array.isArray(body.message)).toBe(true);
      });
  });
});
