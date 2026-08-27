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

function zipLocalEntries(...entryNames: string[]): Buffer {
  const chunks = entryNames.map((entryName) => {
    const name = Buffer.from(entryName, 'utf8');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(name.length, 26);
    return Buffer.concat([header, name]);
  });
  return Buffer.concat(chunks);
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
          zipLocalEntries('[Content_Types].xml', 'xl/workbook.xml'),
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

  it('rejects generic ZIP content disguised as an OOXML document', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'fake.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          zipLocalEntries('random.txt'),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('rejects the wrong OOXML package family', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'fake.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          zipLocalEntries('[Content_Types].xml', 'word/document.xml'),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('accepts a DOCX package with required OOXML entries', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'document.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          zipLocalEntries('[Content_Types].xml', 'word/document.xml'),
        ),
      ]),
    ).not.toThrow();
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
