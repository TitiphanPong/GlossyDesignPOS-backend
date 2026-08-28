import { ConflictException } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { InventoryService } from './inventory.service';
import { StockItemDocument } from './schemas/stock-item.schema';
import { StockMovementDocument } from './schemas/stock-movement.schema';

describe('InventoryService', () => {
  const session = { id: 'session' };
  const actor = { id: '64b000000000000000000001', username: 'manager' };
  const stockItemId = '64b000000000000000000002';

  function makeService(
    options: {
      updatedOnHand?: number | null;
      existingMovement?: Partial<StockMovementDocument> | null;
    } = {},
  ) {
    const updatedOnHand =
      options.updatedOnHand === undefined ? 8 : options.updatedOnHand;
    const existingMovement = options.existingMovement ?? null;

    const findExistingExec = jest.fn().mockResolvedValue(existingMovement);
    const findExistingSessionExec = jest
      .fn()
      .mockResolvedValue(existingMovement);
    const findOne = jest
      .fn()
      .mockReturnValueOnce({ exec: findExistingExec })
      .mockReturnValue({
        session: jest.fn().mockReturnValue({ exec: findExistingSessionExec }),
        exec: findExistingExec,
      });
    const updateExec = jest
      .fn()
      .mockResolvedValue(
        updatedOnHand === null ? null : { onHand: updatedOnHand },
      );
    const findOneAndUpdate = jest.fn().mockReturnValue({ exec: updateExec });
    const findByIdExec = jest
      .fn()
      .mockResolvedValue({ active: true, onHand: 2 });
    const findById = jest.fn().mockReturnValue({
      session: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({ exec: findByIdExec }),
      }),
    });

    const stockItemModel = {
      findOneAndUpdate,
      findById,
      create: jest.fn(),
    } as unknown as Model<StockItemDocument>;
    const stockMovementModel = {
      findOne,
      create: jest
        .fn()
        .mockImplementation((documents: unknown[]) =>
          Promise.resolve(documents),
        ),
    } as unknown as Model<StockMovementDocument>;
    const connection = {
      transaction: jest.fn((callback: (value: unknown) => unknown) =>
        Promise.resolve(callback(session)),
      ),
    } as unknown as Connection;

    return {
      service: new InventoryService(
        stockItemModel,
        stockMovementModel,
        connection,
      ),
      stockItemModel,
      stockMovementModel,
      findOneAndUpdate,
    };
  }

  it.each([
    ['receive', 5],
    ['adjustment_in', 5],
    ['issue', -5],
    ['adjustment_out', -5],
    ['waste', -5],
  ] as const)(
    'maps %s to the server-owned signed delta',
    async (type, delta) => {
      const { service, findOneAndUpdate } = makeService();

      await service.recordMovement(
        stockItemId,
        { type, quantity: 5, reason: 'inventory test' },
        actor,
      );

      expect(findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: stockItemId,
          active: { $ne: false },
          ...(delta < 0 ? { onHand: { $gte: 5 } } : {}),
        }),
        { $inc: { onHand: delta } },
        expect.objectContaining({ new: true, runValidators: true, session }),
      );
    },
  );

  it('rejects an outbound movement when the atomic non-negative guard does not match', async () => {
    const { service } = makeService({ updatedOnHand: null });

    await expect(
      service.recordMovement(
        stockItemId,
        { type: 'issue', quantity: 5, reason: 'use material' },
        actor,
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('replays the same idempotent command without applying stock twice', async () => {
    const first = makeService();
    const command = {
      type: 'receive' as const,
      quantity: 3,
      reason: 'supplier delivery',
      idempotencyKey: 'delivery-001',
    };
    const created = await first.service.recordMovement(
      stockItemId,
      command,
      actor,
    );
    const replay = makeService({ existingMovement: created });

    await expect(
      replay.service.recordMovement(stockItemId, command, actor),
    ).resolves.toBe(created);
    expect(replay.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different command', async () => {
    const first = makeService();
    const created = await first.service.recordMovement(
      stockItemId,
      {
        type: 'receive',
        quantity: 3,
        reason: 'supplier delivery',
        idempotencyKey: 'delivery-002',
      },
      actor,
    );
    const replay = makeService({ existingMovement: created });

    await expect(
      replay.service.recordMovement(
        stockItemId,
        {
          type: 'receive',
          quantity: 4,
          reason: 'supplier delivery',
          idempotencyKey: 'delivery-002',
        },
        actor,
      ),
    ).rejects.toThrow(ConflictException);
  });
});
