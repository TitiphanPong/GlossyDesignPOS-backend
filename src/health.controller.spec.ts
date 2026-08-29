import { ServiceUnavailableException } from '@nestjs/common';
import { IS_PUBLIC_KEY } from './auth/auth.constants';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('keeps liveness cheap and dependency-independent', () => {
    const controller = new HealthController({ isReady: jest.fn() } as never);

    expect(controller.check()).toEqual({ status: 'ok' });
  });

  it('returns ready when dependencies are healthy', async () => {
    const controller = new HealthController({
      isReady: jest.fn().mockResolvedValue(true),
    } as never);

    await expect(controller.readiness()).resolves.toEqual({ status: 'ready' });
  });

  it('fails readiness with 503 semantics when a dependency is unavailable', async () => {
    const controller = new HealthController({
      isReady: jest.fn().mockResolvedValue(false),
    } as never);

    await expect(controller.readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('keeps readiness detail protected while returning only dependency states', async () => {
    const details = {
      status: 'unready' as const,
      checkedAt: '2026-08-29T09:00:00.000Z',
      dependencies: {
        database: 'ready' as const,
        objectStorage: 'unready' as const,
      },
    };
    const getReadinessDetails = jest.fn().mockResolvedValue(details);
    const controller = new HealthController({ getReadinessDetails } as never);

    const handler = Object.getOwnPropertyDescriptor(
      HealthController.prototype,
      'readinessDetails',
    )?.value as object | undefined;
    expect(handler).toBeDefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler!)).not.toBe(true);
    await expect(controller.readinessDetails()).resolves.toEqual(details);
    expect(JSON.stringify(details)).not.toMatch(
      /mongodb_uri|access[_-]?key|secret|bucket|token|credential/i,
    );
  });
});
