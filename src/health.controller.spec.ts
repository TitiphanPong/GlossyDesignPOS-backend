import { ServiceUnavailableException } from '@nestjs/common';
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
});
