import { BadRequestException, ConflictException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { UserDocument } from '../auth/schemas/user.schema';
import { RecordStockMovementCommand } from '../inventory/inventory.service';
import { OrderDocument } from '../orders/orders.schema';
import { UploadDocument } from '../uploads/schemas/upload.schema';
import { ProductionService } from './production.service';
import { ProductionJobDocument } from './schemas/production-job.schema';

const jobId = '64b000000000000000000001';
const orderId = '64b000000000000000000002';
const actor = { id: '64b000000000000000000003', username: 'staff' };

function makeJob(stage: ProductionJobDocument['stage'] = 'file_check') {
  return {
    _id: new Types.ObjectId(jobId),
    jobNumber: 'PJ-20260829-ABCDEF12',
    orderId: new Types.ObjectId(orderId),
    orderNumber: 'OR-0001',
    workSummary: 'Print customer artwork',
    jobType: 'นามบัตร',
    dueAt: new Date('2026-08-30T03:00:00.000Z'),
    priority: 'normal',
    linkedUploadIds: [],
    stage,
    stageHistory: [
      {
        stage,
        changedAt: new Date('2026-08-29T03:00:00.000Z'),
        changedBy: actor.id,
      },
    ],
  } as unknown as ProductionJobDocument;
}

function makeService(current = makeJob()) {
  const findById = jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(current),
  });
  const findOneAndUpdate = jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(makeJob('queued')),
  });
  const productionJobModel = {
    findById,
    findOneAndUpdate,
  } as unknown as Model<ProductionJobDocument>;

  return {
    service: new ProductionService(
      productionJobModel,
      {} as Model<OrderDocument>,
      {} as never,
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
      {} as never,
    ),
    findOneAndUpdate,
  };
}

describe('ProductionService', () => {
  it('enforces one-step forward stage transitions with an atomic current-stage predicate', async () => {
    const { service, findOneAndUpdate } = makeService(makeJob('file_check'));

    const result = await service.updateStage(jobId, 'queued', actor);

    expect(result.stage).toBe('queued');
    expect(result.customerMilestone).toBe('received');
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const callJson = JSON.stringify(findOneAndUpdate.mock.calls);
    expect(callJson).toContain('"stage":"file_check"');
    expect(callJson).toContain('"stage":"queued"');
    expect(callJson).toContain(`"changedBy":"${actor.id}"`);
    expect(callJson).toContain('"runValidators":true');
  });

  it('rejects skip-forward and backward transitions', async () => {
    const { service } = makeService(makeJob('queued'));

    await expect(
      service.updateStage(jobId, 'quality_check', actor),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.updateStage(jobId, 'file_check', actor),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects overlapping order line mappings across sibling production jobs', async () => {
    const current = makeJob('file_check');
    current.orderLineIndexes = [0];
    const findByIdAndUpdate = jest.fn();
    const productionJobModel = {
      findById: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(current) }),
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue({
              _id: new Types.ObjectId('64b000000000000000000099'),
              jobNumber: 'PJ-SIBLING',
              orderLineIndexes: [1],
            }),
          }),
        }),
      }),
      findByIdAndUpdate,
    } as unknown as Model<ProductionJobDocument>;
    const orderModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(orderId),
          cart: [{ name: 'Line 1' }, { name: 'Line 2' }],
        }),
      }),
    } as unknown as Model<OrderDocument>;
    const service = new ProductionService(
      productionJobModel,
      orderModel,
      {} as never,
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
      {} as never,
    );

    await expect(
      service.updateJob(jobId, { orderLineIndexes: [1] }),
    ).rejects.toThrow(ConflictException);
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('locks order line mapping after materials have been issued', async () => {
    const current = makeJob('producing');
    current.materialIssuedAt = new Date('2026-08-31T05:00:00.000Z');
    current.orderLineIndexes = [0];
    const { service } = makeService(current);

    await expect(
      service.updateJob(jobId, { orderLineIndexes: [1] }),
    ).rejects.toThrow(ConflictException);
  });

  it('locks order line mapping as soon as material issue starts', async () => {
    const current = makeJob('queued');
    current.materialIssueStartedAt = new Date('2026-08-31T04:59:59.000Z');
    current.orderLineIndexes = [0];
    const { service } = makeService(current);

    await expect(
      service.updateJob(jobId, { orderLineIndexes: [1] }),
    ).rejects.toThrow(ConflictException);
  });

  it('treats exact same-stage retry as idempotent without appending history', async () => {
    const { service, findOneAndUpdate } = makeService(makeJob('producing'));

    const result = await service.updateStage(jobId, 'producing', actor);

    expect(result.stage).toBe('producing');
    expect(result.customerMilestone).toBe('in_progress');
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('derives ready jobs as customer-safe ready milestones and not overdue', async () => {
    const ready = makeJob('ready');
    ready.dueAt = new Date('2020-01-01T00:00:00.000Z');
    const { service } = makeService(ready);

    const result = await service.getJob(jobId);

    expect(result.customerMilestone).toBe('ready');
    expect(result.isOverdue).toBe(false);
    expect(result.jobType).toBe('นามบัตร');
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('remainingTotal');
    expect(result).not.toHaveProperty('phoneNumber');
  });

  it('issues the mapped canonical variant recipe idempotently before entering producing', async () => {
    const stockItemId = '64b000000000000000000010';
    const productId = '64b000000000000000000011';
    const variantId = '64b000000000000000000012';
    const current = makeJob('queued');
    current.orderLineIndexes = [0];

    const findOneAndUpdate = jest
      .fn()
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue({
          ...current,
          materialIssueStartedAt: new Date('2026-08-31T04:59:59.000Z'),
        }),
      })
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(current) })
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue({
          ...makeJob('producing'),
          orderLineIndexes: [0],
          materialIssueStartedAt: new Date('2026-08-31T04:59:59.000Z'),
          materialIssuedAt: new Date('2026-08-31T05:00:00.000Z'),
        }),
      });
    const productionJobModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(current),
      }),
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
        }),
      }),
      findOneAndUpdate,
    } as unknown as Model<ProductionJobDocument>;
    const orderModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(orderId),
          cart: [
            {
              productId,
              variant: { id: variantId },
              name: 'A4 color',
              qty: 2,
            },
          ],
        }),
      }),
    } as unknown as Model<OrderDocument>;
    const productModel = {
      find: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          {
            _id: new Types.ObjectId(productId),
            variants: [
              {
                _id: new Types.ObjectId(variantId),
                recipe: [
                  {
                    stockItemId,
                    quantity: 1.5,
                    unit: 'sheet',
                  },
                ],
              },
            ],
            recipe: [],
          },
        ]),
      }),
    };
    let capturedMovementCommand: RecordStockMovementCommand | undefined;
    const recordMovement = jest.fn(
      (
        _stockItemId: string,
        command: RecordStockMovementCommand,
      ): Promise<Record<string, never>> => {
        capturedMovementCommand = command;
        return Promise.resolve({});
      },
    );
    const inventoryService = {
      getStockItem: jest
        .fn()
        .mockResolvedValue({ active: true, unit: 'sheet' }),
      recordMovement,
    };
    const service = new ProductionService(
      productionJobModel,
      orderModel,
      productModel as never,
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
      inventoryService as never,
    );

    const result = await service.updateStage(jobId, 'producing', actor);

    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement).toHaveBeenCalledWith(
      stockItemId,
      expect.objectContaining({
        type: 'issue',
        quantity: 3,
        idempotencyKey: `production-job:${jobId}:issue:${stockItemId}`,
        businessReference: { type: 'production-job', id: jobId },
        orderId,
        orderNumber: 'OR-0001',
        productionJobId: jobId,
      }),
      actor,
    );
    expect(capturedMovementCommand?.reasonMetadata).toEqual({
      triggerStage: 'producing',
      productionJobNumber: 'PJ-20260829-ABCDEF12',
      orderLineIndexes: [0],
      recipeSnapshot: [
        expect.objectContaining({
          orderLineIndex: 0,
          productId,
          variantId,
          lineQuantity: 2,
          recipeSource: 'variant',
          recipeQuantity: 1.5,
          recipeUnit: 'sheet',
          stockUnit: 'sheet',
          issuedQuantity: 3,
        }),
      ],
    });
    expect(result.stage).toBe('producing');
    expect(findOneAndUpdate).toHaveBeenCalledTimes(3);
    expect((findOneAndUpdate.mock.calls as unknown[][])[0]?.[0]).toEqual(
      expect.objectContaining({
        _id: current._id,
        materialIssueStartedAt: { $exists: false },
        materialIssuedAt: { $exists: false },
        orderLineIndexes: [0],
      }),
    );
    expect(findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      recordMovement.mock.invocationCallOrder[0],
    );
  });

  it('requires explicit order line mapping when sibling jobs share an order', async () => {
    const productId = '64b000000000000000000011';
    const current = makeJob('queued');
    current.orderLineIndexes = [];
    const findOneAndUpdate = jest.fn();
    const productionJobModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(current),
      }),
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(2),
      }),
      findOneAndUpdate,
    } as unknown as Model<ProductionJobDocument>;
    const orderModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(orderId),
          cart: [{ productId, name: 'A4 color', qty: 1 }],
        }),
      }),
    } as unknown as Model<OrderDocument>;
    const recordMovement = jest.fn();
    const service = new ProductionService(
      productionJobModel,
      orderModel,
      {} as never,
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
      { getStockItem: jest.fn(), recordMovement } as never,
    );

    await expect(
      service.updateStage(jobId, 'producing', actor),
    ).rejects.toThrow(BadRequestException);
    expect(recordMovement).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('fails visibly without a recipe and does not advance or consume stock', async () => {
    const productId = '64b000000000000000000011';
    const current = makeJob('queued');
    current.orderLineIndexes = [0];
    const findOneAndUpdate = jest.fn();
    const productionJobModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(current),
      }),
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
        }),
      }),
      findOneAndUpdate,
    } as unknown as Model<ProductionJobDocument>;
    const orderModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(orderId),
          cart: [{ productId, name: 'Custom print', qty: 1 }],
        }),
      }),
    } as unknown as Model<OrderDocument>;
    const productModel = {
      find: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          {
            _id: new Types.ObjectId(productId),
            variants: [],
            recipe: [],
          },
        ]),
      }),
    };
    const recordMovement = jest.fn();
    const service = new ProductionService(
      productionJobModel,
      orderModel,
      productModel as never,
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
      { getStockItem: jest.fn(), recordMovement } as never,
    );

    await expect(
      service.updateStage(jobId, 'producing', actor),
    ).rejects.toThrow(BadRequestException);
    expect(recordMovement).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('applies an explicit unit conversion factor when issuing a recipe', async () => {
    const stockItemId = '64b000000000000000000010';
    const productId = '64b000000000000000000011';
    const current = makeJob('queued');
    current.orderLineIndexes = [0];
    const findOneAndUpdate = jest
      .fn()
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue({
          ...current,
          materialIssueStartedAt: new Date('2026-08-31T04:59:59.000Z'),
        }),
      })
      .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(current) })
      .mockReturnValueOnce({
        exec: jest.fn().mockResolvedValue({
          ...makeJob('producing'),
          orderLineIndexes: [0],
          materialIssueStartedAt: new Date('2026-08-31T04:59:59.000Z'),
          materialIssuedAt: new Date('2026-08-31T05:00:00.000Z'),
        }),
      });
    const productionJobModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(current),
      }),
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
        }),
      }),
      findOneAndUpdate,
    } as unknown as Model<ProductionJobDocument>;
    const orderModel = {
      findById: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(orderId),
          cart: [{ productId, name: 'Sticker', qty: 2 }],
        }),
      }),
    } as unknown as Model<OrderDocument>;
    const productModel = {
      find: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue([
          {
            _id: new Types.ObjectId(productId),
            variants: [],
            recipe: [
              {
                stockItemId,
                quantity: 50,
                unit: 'cm',
                conversionFactor: 0.01,
              },
            ],
          },
        ]),
      }),
    };
    const recordMovement = jest.fn().mockResolvedValue({});
    const service = new ProductionService(
      productionJobModel,
      orderModel,
      productModel as never,
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
      {
        getStockItem: jest.fn().mockResolvedValue({ active: true, unit: 'm' }),
        recordMovement,
      } as never,
    );

    await service.updateStage(jobId, 'producing', actor);

    expect(recordMovement).toHaveBeenCalledWith(
      stockItemId,
      expect.objectContaining({ quantity: 1 }),
      actor,
    );
  });

  it('paginates beyond 100 jobs and searches customer names without a 100-Order id cap', async () => {
    const jobs = Array.from({ length: 25 }, (_, index) => ({
      ...makeJob(index % 2 === 0 ? 'queued' : 'producing'),
      _id: new Types.ObjectId(),
      jobNumber: `PJ-${index + 101}`,
    })) as ProductionJobDocument[];
    let capturedPipeline: unknown[] = [];
    const aggregate = jest.fn((pipeline: unknown[]) => {
      capturedPipeline = pipeline;
      return Promise.resolve([
        {
          items: jobs,
          total: [{ count: 125 }],
          stageCounts: [
            { _id: 'queued', count: 62 },
            { _id: 'producing', count: 63 },
          ],
        },
      ]);
    });
    const productionJobModel = {
      aggregate,
    } as unknown as Model<ProductionJobDocument>;
    const service = new ProductionService(
      productionJobModel,
      { collection: { name: 'orders' } } as unknown as Model<OrderDocument>,
      {} as never,
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
      {} as never,
    );

    const result = await service.listJobs({
      q: 'สมชาย',
      jobType: 'นามบัตร',
      page: 5,
      limit: 25,
    });

    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(125);
    expect(result.totalPages).toBe(5);
    expect(result.items).toHaveLength(25);
    expect(result.stageCounts.queued).toBe(62);
    expect(result.stageCounts.producing).toBe(63);
    expect(result.items[0]).not.toHaveProperty('customerName');

    const serializedPipeline = JSON.stringify(capturedPipeline);
    expect(serializedPipeline).toContain('"$lookup"');
    expect(serializedPipeline).toContain('"from":"orders"');
    expect(serializedPipeline).toContain('"_searchOrder.customerName"');
    expect(serializedPipeline).toContain('"$skip":100');
    expect(serializedPipeline).not.toContain('"$limit":100');
    expect(serializedPipeline).not.toContain('"$in"');
  });
});
