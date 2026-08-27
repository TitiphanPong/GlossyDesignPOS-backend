import { BadRequestException } from '@nestjs/common';
import {
  MAX_UPLOAD_REQUEST_BYTES,
  validateUploadedFiles,
} from './upload-file.validator';

function file(
  originalname: string,
  mimetype: string,
  buffer: Buffer,
  size = buffer.length,
): Express.Multer.File {
  return {
    fieldname: 'files',
    originalname,
    encoding: '7bit',
    mimetype,
    size,
    buffer,
    destination: '',
    filename: originalname,
    path: '',
    stream: undefined as never,
  };
}

describe('validateUploadedFiles', () => {
  it('accepts supported files only when extension, MIME, and signature agree', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'proof.pdf',
          'application/pdf',
          Buffer.from('%PDF-1.7\nmock', 'ascii'),
        ),
        file(
          'photo.jpg',
          'image/jpeg',
          Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]),
        ),
        file(
          'artwork.psd',
          'image/vnd.adobe.photoshop',
          Buffer.from('8BPSmock', 'ascii'),
        ),
        file(
          'sheet.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]),
        ),
      ]),
    ).not.toThrow();
  });

  it('rejects a spoofed extension even when both extension and MIME are individually allowed', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'fake.jpg',
          'application/pdf',
          Buffer.from('%PDF-1.7\nnot-an-image', 'ascii'),
        ),
      ]),
    ).toThrow(BadRequestException);
  });

  it('rejects content whose signature does not match the declared type', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'fake.pdf',
          'application/pdf',
          Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('rejects binary payloads disguised as CSV', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'data.csv',
          'text/csv',
          Buffer.from([0x61, 0x2c, 0x62, 0x00, 0x01]),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('rejects requests whose combined file sizes exceed the aggregate budget', () => {
    const first = file(
      'one.pdf',
      'application/pdf',
      Buffer.from('%PDF-1.7', 'ascii'),
      Math.floor(MAX_UPLOAD_REQUEST_BYTES / 2) + 1,
    );
    const second = file(
      'two.pdf',
      'application/pdf',
      Buffer.from('%PDF-1.7', 'ascii'),
      Math.floor(MAX_UPLOAD_REQUEST_BYTES / 2) + 1,
    );

    expect(() => validateUploadedFiles([first, second])).toThrow(
      'Upload request too large',
    );
  });
});
