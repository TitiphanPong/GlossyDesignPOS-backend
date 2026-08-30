import { AuditService } from '../auth/audit.service';
import { LineLoginService } from '../line/line-login.service';
import { JobType } from './uploads.enums';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

describe('UploadsController LINE intake', () => {
  function createController() {
    const createUpload = jest.fn().mockResolvedValue({ id: 'upload-1' });
    const verifyIdToken = jest.fn().mockResolvedValue({
      userId: 'U1234567890',
      displayName: 'LINE Customer',
      pictureUrl: 'https://profile.line-scdn.net/example',
    });
    const controller = new UploadsController(
      { createUpload } as unknown as UploadsService,
      {} as AuditService,
      { verifyIdToken } as unknown as LineLoginService,
    );
    return { controller, createUpload, verifyIdToken };
  }

  const files = [
    {
      originalname: 'sample.pdf',
      mimetype: 'application/pdf',
      size: 12,
      buffer: Buffer.from('%PDF-1.4 test'),
    },
  ] as Express.Multer.File[];

  it('derives LINE identity from a verified ID token and ignores client identity fields', async () => {
    const { controller, createUpload, verifyIdToken } = createController();

    await controller.createUpload(
      {
        customerName: 'Spoofed Name',
        lineIdToken: 'verified-line-id-token',
        jobType: JobType.DOCUMENT_PRINTING,
      },
      files,
    );

    expect(verifyIdToken).toHaveBeenCalledWith('verified-line-id-token');
    expect(createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        customerName: 'LINE Customer',
        lineUserId: 'U1234567890',
        displayName: 'LINE Customer',
        linePictureUrl: 'https://profile.line-scdn.net/example',
        jobType: JobType.DOCUMENT_PRINTING,
      }),
      files,
    );
    expect(createUpload).toHaveBeenCalledWith(
      expect.not.objectContaining({ lineIdToken: 'verified-line-id-token' }),
      files,
    );
  });

  it('keeps ordinary public uploads anonymous to LINE when no token is supplied', async () => {
    const { controller, createUpload, verifyIdToken } = createController();

    await controller.createUpload(
      {
        customerName: 'Upload Customer',
        jobType: JobType.DOCUMENT_PRINTING,
      },
      files,
    );

    expect(verifyIdToken).not.toHaveBeenCalled();
    expect(createUpload).toHaveBeenCalledWith(
      {
        customerName: 'Upload Customer',
        jobType: JobType.DOCUMENT_PRINTING,
      },
      files,
    );
  });
});
