import { extname } from 'path';
import { BadRequestException } from '@nestjs/common';

export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.jpg',
  '.jpeg',
  '.png',
  '.ai',
  '.psd',
  '.zip',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.csv',
]);

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/postscript',
  'image/vnd.adobe.photoshop',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
]);

export function sanitizeFilename(originalName: string): string {
  const normalized = originalName.normalize('NFKC').replace(/\s+/g, '_');
  return normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function validateUploadedFiles(files: Express.Multer.File[]): void {
  if (!files.length) {
    throw new BadRequestException('At least one file is required');
  }

  for (const file of files) {
    const ext = extname(file.originalname).toLowerCase();

    if (
      !ALLOWED_EXTENSIONS.has(ext) ||
      !ALLOWED_MIME_TYPES.has(file.mimetype)
    ) {
      throw new BadRequestException(`Invalid file type: ${file.originalname}`);
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(`File too large: ${file.originalname}`);
    }
  }
}
