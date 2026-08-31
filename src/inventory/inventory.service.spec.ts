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
    const createMovement = jest
      .fn()
      .mockImplementation((documents: unknown[]) => Promise.resolve(documents));
    const stockMovementModel = {
      findOne,
      create: createMovement,
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
      createMovement,
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

  it('keeps manual idempotency keys bound to the original actor', async () => {
    const first = makeService();
    const command = {
      type: 'issue' as const,
      quantity: 2,
      reason: 'manual material issue',
      idempotencyKey: 'manual-issue-001',
    };
    const created = await first.service.recordMovement(
      stockItemId,
      command,
      actor,
    );
    const replay = makeService({ existingMovement: created });

    await expect(
      replay.service.recordMovement(stockItemId, command, {
        id: '64b000000000000000000099',
        username: 'staff-retry',
      }),
    ).rejects.toThrow(ConflictException);
    expect(replay.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('replays a global production idempotency command across staff retries', async () => {
    const first = makeService();
    const command = {
      type: 'issue' as const,
      quantity: 2,
      reason: 'production job material',
      idempotencyKey: 'production-job:job-1:issue:item-1',
      idempotencyScope: 'global' as const,
      businessReference: { type: 'production-job', id: 'job-1' },
    };
    const created = await first.service.recordMovement(
      stockItemId,
      command,
      actor,
    );
    const replay = makeService({ existingMovement: created });

    await expect(
      replay.service.recordMovement(stockItemId, command, {
        id: '64b000000000000000000099',
        username: 'staff-retry',
      }),
    ).resolves.toBe(created);
    expect(replay.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('persists production order metadata and immutable recipe snapshot context', async () => {
    const { service, createMovement } = makeService();
    const command = {
      type: 'issue' as const,
      quantity: 2,
      reason: 'production material issue',
      idempotencyKey: 'production-job:job-1:issue:item-1',
      businessReference: { type: 'production-job', id: 'job-1' },
      orderId: 'order-1',
      orderNumber: 'OR-0001',
      productionJobId: 'job-1',
      reasonMetadata: {
        triggerStage: 'producing',
        recipeSnapshot: [{ orderLineIndex: 0, issuedQuantity: 2 }],
      },
    };

    const created = await service.recordMovement(stockItemId, command, actor);

    expect(createMovement).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          orderId: 'order-1',
          orderNumber: 'OR-0001',
          productionJobId: 'job-1',
          reasonMetadata: command.reasonMetadata,
        }),
      ],
      { session },
    );

    const replay = makeService({ existingMovement: created });
    await expect(
      replay.service.recordMovement(
        stockItemId,
        {
          ...command,
          reasonMetadata: {
            triggerStage: 'producing',
            recipeSnapshot: [{ orderLineIndex: 0, issuedQuantity: 3 }],
          },
        },
        actor,
      ),
    ).rejects.toThrow(ConflictException);
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

  it('counts filtered movement history before applying server pagination', async () => {
    const countExec = jest.fn().mockResolvedValue(51);
    const countDocuments = jest.fn().mockReturnValue({ exec: countExec });
    const movement = {
      _id: '64b000000000000000000003',
      stockItemId,
      type: 'issue',
      occurredAt: new Date('2026-08-28T05:00:00.000Z'),
    };
    const movementExec = jest.fn().mockResolvedValue([movement]);
    const limit = jest.fn().mockReturnValue({
      lean: jest.fn().mockReturnValue({ exec: movementExec }),
    });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    const findMovements = jest.fn().mockReturnValue({ sort });

    const item = {
      _id: stockItemId,
      code: 'PAPER-A4',
      name: 'A4 paper',
      unit: 'ream',
    };
    const itemExec = jest.fn().mockResolvedValue([item]);
    const findItems = jest
      .fn()
      .mockReturnValue({ lean: jest.fn().mockReturnValue({ exec: itemExec }) });

    const service = new InventoryService(
      { find: findItems } as unknown as Model<StockItemDocument>,
      {
        countDocuments,
        find: findMovements,
      } as unknown as Model<StockMovementDocument>,
      {} as Connection,
    );

    const result = await service.listStockMovements({
      page: 2,
      limit: 25,
      itemId: stockItemId,
      type: 'issue',
      referenceType: 'production-job',
      referenceId: 'JOB-0001',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T23:59:59.999Z',
    });

    expect(countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'issue',
        referenceType: 'production-job',
        referenceId: 'JOB-0001',
        occurredAt: {
          $gte: new Date('2026-08-01T00:00:00.000Z'),
          $lte: new Date('2026-08-31T23:59:59.999Z'),
        },
      }),
    );
    expect(skip).toHaveBeenCalledWith(25);
    expect(limit).toHaveBeenCalledWith(25);
    expect(result).toMatchObject({
      page: 2,
      limit: 25,
      total: 51,
      totalPages: 3,
    });
    expect(result.items[0]?.stockItem).toMatchObject({
      code: 'PAPER-A4',
      unit: 'ream',
    });
  });
});
