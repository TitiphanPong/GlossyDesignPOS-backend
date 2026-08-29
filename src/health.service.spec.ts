import { HealthService } from './health.service';

describe('HealthService', () => {
  const createService = (options?: { mongoError?: Error; s3Error?: Error }) => {
    const ping = options?.mongoError
      ? jest.fn().mockRejectedValue(options.mongoError)
      : jest.fn().mockResolvedValue({ ok: 1 });
    const checkReadiness = options?.s3Error
      ? jest.fn().mockRejectedValue(options.s3Error)
      : jest.fn().mockResolvedValue(undefined);

    const service = new HealthService(
      {
        db: {
          admin: () => ({ ping }),
        },
      } as never,
      { checkReadiness } as never,
    );

    return { service, ping, checkReadiness };
  };

  it('is ready only when MongoDB and S3 are reachable', async () => {
    const { service, ping, checkReadiness } = createService();

    await expect(service.isReady()).resolves.toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(checkReadiness).toHaveBeenCalledWith(2_500);
  });

  it('returns secret-free readiness details for healthy dependencies', async () => {
    const { service } = createService();

    await expect(service.getReadinessDetails()).resolves.toMatchObject({
      status: 'ready',
      dependencies: {
        database: 'ready',
        objectStorage: 'ready',
      },
    });
  });

  it('is unready when MongoDB is unavailable', async () => {
    const { service } = createService({ mongoError: new Error('offline') });

    await expect(service.isReady()).resolves.toBe(false);
    await expect(service.getReadinessDetails()).resolves.toMatchObject({
      status: 'unready',
      dependencies: {
        database: 'unready',
        objectStorage: 'ready',
      },
    });
  });

  it('is unready when S3 is unavailable', async () => {
    const { service } = createService({ s3Error: new Error('offline') });

    await expect(service.isReady()).resolves.toBe(false);
    await expect(service.getReadinessDetails()).resolves.toMatchObject({
      status: 'unready',
      dependencies: {
        database: 'ready',
        objectStorage: 'unready',
      },
    });
  });
});
