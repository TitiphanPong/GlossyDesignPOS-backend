import { ConflictException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { UserDocument } from '../auth/schemas/user.schema';
import { OrderDocument } from '../orders/orders.schema';
import { UploadDocument } from '../uploads/schemas/upload.schema';
import { ProductionService } from './production.service';
import { ProductionJobDocument } from './schemas/production-job.schema';

const jobId = '64b000000000000000000001';
const orderId = '64b000000000000000000002';
const actor = { id: '64b000000000000000000003' };

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
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
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
      {} as Model<UploadDocument>,
      {} as Model<UserDocument>,
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
