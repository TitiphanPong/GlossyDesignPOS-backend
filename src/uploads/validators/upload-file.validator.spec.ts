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

function zipPackageEntries(
  entries: Array<{ name: string; payload?: Buffer }>,
): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = entry.payload ?? Buffer.alloc(0);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(payload.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    const localChunk = Buffer.concat([localHeader, name, payload]);
    localChunks.push(localChunk);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(payload.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralChunks.push(Buffer.concat([centralHeader, name]));
    localOffset += localChunk.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localChunks, centralDirectory, eocd]);
}

function zipPackage(...entryNames: string[]): Buffer {
  return zipPackageEntries(entryNames.map((name) => ({ name })));
}

function fakeLocalHeader(entryName: string): Buffer {
  const name = Buffer.from(entryName, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name]);
}

function zipWithForgedEntriesInsidePayload(): Buffer {
  const outerName = Buffer.from('random.bin', 'utf8');
  const nestedContentTypes = fakeLocalHeader('[Content_Types].xml');
  const nestedDocument = fakeLocalHeader('word/document.xml');
  const payload = Buffer.concat([nestedContentTypes, nestedDocument]);
  const outerHeader = Buffer.alloc(30);
  outerHeader.writeUInt32LE(0x04034b50, 0);
  outerHeader.writeUInt16LE(20, 4);
  outerHeader.writeUInt32LE(payload.length, 18);
  outerHeader.writeUInt32LE(payload.length, 22);
  outerHeader.writeUInt16LE(outerName.length, 26);
  const localArea = Buffer.concat([outerHeader, outerName, payload]);
  const payloadOffset = outerHeader.length + outerName.length;

  const centralEntry = (
    entryName: string,
    localHeaderOffset: number,
    compressedSize: number,
  ) => {
    const name = Buffer.from(entryName, 'utf8');
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(compressedSize, 20);
    header.writeUInt32LE(compressedSize, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(localHeaderOffset, 42);
    return Buffer.concat([header, name]);
  };

  const centralDirectory = Buffer.concat([
    centralEntry('random.bin', 0, payload.length),
    centralEntry('[Content_Types].xml', payloadOffset, 0),
    centralEntry(
      'word/document.xml',
      payloadOffset + nestedContentTypes.length,
      0,
    ),
  ]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(3, 8);
  eocd.writeUInt16LE(3, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localArea.length, 16);
  return Buffer.concat([localArea, centralDirectory, eocd]);
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
          zipPackage('[Content_Types].xml', 'xl/workbook.xml'),
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
          zipPackage('random.txt'),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('rejects fake OOXML local headers embedded only in ZIP payload data', () => {
    const payload = Buffer.concat([
      fakeLocalHeader('[Content_Types].xml'),
      fakeLocalHeader('word/document.xml'),
    ]);

    expect(() =>
      validateUploadedFiles([
        file(
          'fake.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          zipPackageEntries([{ name: 'random.bin', payload }]),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('rejects central-directory entries that point into another entry payload', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'fake.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          zipWithForgedEntriesInsidePayload(),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('rejects forged central-directory names that do not match their local file headers', () => {
    const forged = Buffer.from(
      zipPackage('[Content_Types].xml', 'word/document.xml'),
    );
    const requiredName = Buffer.from('[Content_Types].xml', 'utf8');
    const localNameOffset = forged.indexOf(requiredName);
    expect(localNameOffset).toBeGreaterThanOrEqual(0);
    Buffer.alloc(requiredName.length, 0x78).copy(forged, localNameOffset);

    expect(() =>
      validateUploadedFiles([
        file(
          'fake.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          forged,
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
          zipPackage('[Content_Types].xml', 'word/document.xml'),
        ),
      ]),
    ).toThrow('File content does not match its declared type');
  });

  it('rejects OOXML-looking folders that omit the required core document part', () => {
    expect(() =>
      validateUploadedFiles([
        file(
          'fake.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          zipPackage('[Content_Types].xml', 'word/random.txt'),
        ),
      ]),
    ).toThrow('File content does not match its declared type');

    expect(() =>
      validateUploadedFiles([
        file(
          'fake.xlsx',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          zipPackage('[Content_Types].xml', 'xl/random.txt'),
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
          zipPackage('[Content_Types].xml', 'word/document.xml'),
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
