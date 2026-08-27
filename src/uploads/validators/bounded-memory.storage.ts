import { MulterError, type StorageEngine } from 'multer';
import type { Request } from 'express';

const REQUEST_BYTES = Symbol('glossyUploadRequestBytes');

type BoundedRequest = Request & {
  [REQUEST_BYTES]?: number;
};

export class BoundedMemoryStorage implements StorageEngine {
  constructor(private readonly maxRequestBytes: number) {}

  _handleFile(
    req: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void,
  ): void {
    const request = req as BoundedRequest;
    const chunks: Buffer[] = [];
    let fileBytes = 0;
    let finished = false;

    const fail = () => {
      if (finished) return;
      finished = true;
      file.stream.removeAllListeners('data');
      file.stream.removeAllListeners('end');
      file.stream.resume();
      callback(new MulterError('LIMIT_FILE_SIZE', file.fieldname));
    };

    file.stream.on('data', (chunk: Buffer) => {
      if (finished) return;
      const nextTotal = (request[REQUEST_BYTES] ?? 0) + chunk.length;
      request[REQUEST_BYTES] = nextTotal;
      if (nextTotal > this.maxRequestBytes) {
        fail();
        return;
      }
      fileBytes += chunk.length;
      chunks.push(chunk);
    });

    file.stream.on('error', (error) => {
      if (finished) return;
      finished = true;
      callback(error);
    });

    file.stream.on('end', () => {
      if (finished) return;
      finished = true;
      callback(undefined, {
        buffer: Buffer.concat(chunks),
        size: fileBytes,
      });
    });
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    delete (file as Partial<Express.Multer.File>).buffer;
    callback(null);
  }
}
