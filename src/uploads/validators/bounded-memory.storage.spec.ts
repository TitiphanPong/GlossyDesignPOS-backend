import { PassThrough } from 'node:stream';
import type { Request } from 'express';
import { BoundedMemoryStorage } from './bounded-memory.storage';

function incomingFile(stream: PassThrough): Express.Multer.File {
  return {
    fieldname: 'files',
    originalname: 'sample.pdf',
    encoding: '7bit',
    mimetype: 'application/pdf',
    stream,
  } as Express.Multer.File;
}

function rejectAsError(reject: (reason?: unknown) => void, error: unknown) {
  reject(error instanceof Error ? error : new Error(String(error)));
}

describe('BoundedMemoryStorage', () => {
  it('buffers files while the request remains within the aggregate budget', async () => {
    const storage = new BoundedMemoryStorage(10);
    const request = {} as Request;
    const stream = new PassThrough();

    const result = new Promise<Partial<Express.Multer.File>>(
      (resolve, reject) => {
        storage._handleFile(request, incomingFile(stream), (error, info) => {
          if (error) rejectAsError(reject, error);
          else resolve(info ?? {});
        });
      },
    );

    stream.end(Buffer.from('hello'));

    await expect(result).resolves.toMatchObject({
      size: 5,
      buffer: Buffer.from('hello'),
    });
  });

  it('shares one byte budget across files from the same request', async () => {
    const storage = new BoundedMemoryStorage(8);
    const request = {} as Request;

    const store = (payload: string) => {
      const stream = new PassThrough();
      const outcome = new Promise<Partial<Express.Multer.File>>(
        (resolve, reject) => {
          storage._handleFile(request, incomingFile(stream), (error, info) => {
            if (error) rejectAsError(reject, error);
            else resolve(info ?? {});
          });
        },
      );
      stream.end(Buffer.from(payload));
      return outcome;
    };

    await expect(store('12345')).resolves.toMatchObject({ size: 5 });
    await expect(store('6789')).rejects.toMatchObject({
      code: 'LIMIT_FILE_SIZE',
    });
  });
});
