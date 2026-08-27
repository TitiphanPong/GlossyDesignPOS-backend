import { extname } from 'node:path';
import { BadRequestException } from '@nestjs/common';

export const MAX_FILE_SIZE_BYTES = 7_500_000;
export const MAX_UPLOAD_REQUEST_BYTES = 25_000_000;

// Public-upload policy: fail closed before persistence. Files with incompatible
// extension/MIME/signature are rejected rather than quarantined in S3.

const EXTENSION_MIME_TYPES: Readonly<Record<string, ReadonlySet<string>>> = {
  '.pdf': new Set(['application/pdf']),
  '.jpg': new Set(['image/jpeg']),
  '.jpeg': new Set(['image/jpeg']),
  '.png': new Set(['image/png']),
  '.ai': new Set(['application/pdf', 'application/postscript']),
  '.psd': new Set(['image/vnd.adobe.photoshop', 'application/octet-stream']),
  '.zip': new Set(['application/zip', 'application/x-zip-compressed']),
  '.doc': new Set(['application/msword']),
  '.docx': new Set([
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]),
  '.xls': new Set(['application/vnd.ms-excel']),
  '.xlsx': new Set([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ]),
  '.csv': new Set(['text/csv', 'text/plain', 'application/vnd.ms-excel']),
};

const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];
const OLE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);

function startsWith(buffer: Buffer, signature: Buffer): boolean {
  return (
    buffer.length >= signature.length &&
    buffer.subarray(0, signature.length).equals(signature)
  );
}

function isZip(buffer: Buffer): boolean {
  return ZIP_SIGNATURES.some((signature) => startsWith(buffer, signature));
}

function isCsvLike(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return false;

  let disallowedControls = 0;
  for (const byte of sample) {
    const isAllowedWhitespace = byte === 0x09 || byte === 0x0a || byte === 0x0d;
    if (byte < 0x20 && !isAllowedWhitespace) disallowedControls += 1;
  }
  return disallowedControls === 0;
}

function hasExpectedSignature(extension: string, buffer: Buffer): boolean {
  switch (extension) {
    case '.pdf':
      return startsWith(buffer, Buffer.from('%PDF-', 'ascii'));
    case '.jpg':
    case '.jpeg':
      return startsWith(buffer, Buffer.from([0xff, 0xd8, 0xff]));
    case '.png':
      return startsWith(
        buffer,
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
    case '.ai':
      return (
        startsWith(buffer, Buffer.from('%PDF-', 'ascii')) ||
        startsWith(buffer, Buffer.from('%!PS-Adobe', 'ascii'))
      );
    case '.psd':
      return startsWith(buffer, Buffer.from('8BPS', 'ascii'));
    case '.zip':
    case '.docx':
    case '.xlsx':
      return isZip(buffer);
    case '.doc':
    case '.xls':
      return startsWith(buffer, OLE_SIGNATURE);
    case '.csv':
      return isCsvLike(buffer);
    default:
      return false;
  }
}

export function sanitizeFilename(originalName: string): string {
  const normalized = originalName.normalize('NFKC').replace(/\s+/g, '_');
  return normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function validateUploadedFiles(files: Express.Multer.File[]): void {
  if (!files.length) {
    throw new BadRequestException('At least one file is required');
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_UPLOAD_REQUEST_BYTES) {
    throw new BadRequestException(
      `Upload request too large. Maximum total size is ${MAX_UPLOAD_REQUEST_BYTES} bytes`,
    );
  }

  for (const file of files) {
    const ext = extname(file.originalname).toLowerCase();
    const allowedMimeTypes = EXTENSION_MIME_TYPES[ext];

    if (!allowedMimeTypes?.has(file.mimetype)) {
      throw new BadRequestException(`Invalid file type: ${file.originalname}`);
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(`File too large: ${file.originalname}`);
    }

    if (!hasExpectedSignature(ext, file.buffer)) {
      throw new BadRequestException(
        `File content does not match its declared type: ${file.originalname}`,
      );
    }
  }
}
