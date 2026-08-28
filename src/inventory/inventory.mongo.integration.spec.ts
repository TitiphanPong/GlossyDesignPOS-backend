import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Connection, Model, createConnection } from 'mongoose';
import { InventoryService } from './inventory.service';
import {
  StockItem,
  StockItemDocument,
  StockItemSchema,
} from './schemas/stock-item.schema';
import {
  StockMovement,
  StockMovementDocument,
  StockMovementSchema,
} from './schemas/stock-movement.schema';

jest.setTimeout(120_000);

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === '1' ? describe : describe.skip;

describeMongo('InventoryService against replica-set MongoDB', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;
  let stockItemModel: Model<StockItemDocument>;
  let stockMovementModel: Model<StockMovementDocument>;
  let service: InventoryService;

  const actor = { id: '64b000000000000000000001', username: 'inventory-admin' };

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    connection = createConnection(replSet.getUri(), {
      dbName: 'glossy-inventory-integrity',
    });
    await connection.asPromise();
    stockItemModel = connection.model(
      StockItem.name,
      StockItemSchema,
    ) as unknown as Model<StockItemDocument>;
    stockMovementModel = connection.model(
      StockMovement.name,
      StockMovementSchema,
    ) as unknown as Model<StockMovementDocument>;
    await Promise.all([
      stockItemModel.syncIndexes(),
      stockMovementModel.syncIndexes(),
    ]);
    service = new InventoryService(
      stockItemModel,
      stockMovementModel,
      connection,
    );
  });

  afterAll(async () => {
    await connection?.close();
    await replSet?.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      stockItemModel.deleteMany({}),
      stockMovementModel.deleteMany({}),
    ]);
  });

  async function createItem() {
    return service.createStockItem({
      code: `PAPER-${randomUUID()}`,
      name: 'A4 Paper',
      unit: 'sheet',
      minimumLevel: 10,
    });
  }

  it('does not lose concurrent inbound stock movements', async () => {
    const item = await createItem();

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.recordMovement(
          item._id.toString(),
          {
            type: 'receive',
            quantity: 2,
            reason: 'concurrent receive',
            idempotencyKey: `receive-${index}`,
          },
          actor,
        ),
      ),
    );

    const stored = await stockItemModel.findById(item._id).lean().exec();
    expect(stored?.onHand).toBe(10);
    expect(await stockMovementModel.countDocuments()).toBe(5);
  });

  it('allows only one competing outbound movement when both cannot fit', async () => {
    const item = await createItem();
    await service.recordMovement(
      item._id.toString(),
      { type: 'receive', quantity: 5, reason: 'opening receipt' },
      actor,
    );

    const results = await Promise.allSettled([
      service.recordMovement(
        item._id.toString(),
        { type: 'issue', quantity: 4, reason: 'job A' },
        actor,
      ),
      service.recordMovement(
        item._id.toString(),
        { type: 'issue', quantity: 4, reason: 'job B' },
        actor,
      ),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toBeDefined();
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(ConflictException);
    }
    const stored = await stockItemModel.findById(item._id).lean().exec();
    expect(stored?.onHand).toBe(1);
    expect(await stockMovementModel.countDocuments({ type: 'issue' })).toBe(1);
  });

  it('deduplicates concurrent retries with the same idempotency key', async () => {
    const item = await createItem();
    const command = {
      type: 'receive' as const,
      quantity: 3,
      reason: 'same supplier receipt',
      idempotencyKey: 'supplier-receipt-001',
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.recordMovement(item._id.toString(), command, actor),
      ),
    );

    expect(
      new Set(results.map((movement) => movement._id.toString())).size,
    ).toBe(1);
    const stored = await stockItemModel.findById(item._id).lean().exec();
    expect(stored?.onHand).toBe(3);
    expect(await stockMovementModel.countDocuments()).toBe(1);
  });
});
