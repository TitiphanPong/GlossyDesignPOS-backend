import { Logger } from '@nestjs/common';
import { Model } from 'mongoose';
import { AuditService } from './audit.service';
import { AuditEventDocument } from './schemas/audit-event.schema';

describe('AuditService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns true when the audit event is persisted', async () => {
    const create = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({
      create,
    } as unknown as Model<AuditEventDocument>);

    await expect(
      service.record(null, 'order.update', { type: 'order', id: 'order-1' }),
    ).resolves.toBe(true);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUsername: 'anonymous',
        action: 'order.update',
        targetType: 'order',
        targetId: 'order-1',
      }),
    );
  });

  it('does not reject a completed operation when audit persistence fails', async () => {
    const persistenceError = new Error('audit database unavailable');
    const create = jest.fn().mockRejectedValue(persistenceError);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const service = new AuditService({
      create,
    } as unknown as Model<AuditEventDocument>);

    await expect(
      service.record(null, 'order.payment.add', {
        type: 'order',
        id: 'order-2',
      }),
    ).resolves.toBe(false);

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('order.payment.add'),
      persistenceError.stack,
    );
  });
});
