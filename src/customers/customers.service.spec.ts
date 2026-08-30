import { Model, Types } from 'mongoose';
import { OrderDocument } from '../orders/orders.schema';
import { ProductionJobDocument } from '../production/schemas/production-job.schema';
import { UploadDocument } from '../uploads/schemas/upload.schema';
import { CustomersService } from './customers.service';
import { CustomerDocument } from './schemas/customer.schema';

function chainResult<T>(value: T) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(value),
  };
}

describe('CustomersService', () => {
  it('creates a distinct explicit customer identity instead of auto-merging equal names', async () => {
    const create = jest
      .fn()
      .mockResolvedValueOnce({
        _id: new Types.ObjectId(),
        customerCode: 'CUS-AAAA',
        displayName: 'สมชาย',
      })
      .mockResolvedValueOnce({
        _id: new Types.ObjectId(),
        customerCode: 'CUS-BBBB',
        displayName: 'สมชาย',
      });
    const service = new CustomersService(
      { create } as unknown as Model<CustomerDocument>,
      {} as Model<OrderDocument>,
      {} as Model<ProductionJobDocument>,
      {} as Model<UploadDocument>,
    );

    const first = await service.create({ displayName: 'สมชาย' });
    const second = await service.create({ displayName: 'สมชาย' });

    expect(create).toHaveBeenCalledTimes(2);
    expect(first.customerCode).not.toBe(second.customerCode);
  });

  it('stores multiple phone numbers while keeping the first as the legacy primary phone', async () => {
    const create = jest.fn((value: Record<string, unknown>) =>
      Promise.resolve(value),
    );
    const service = new CustomersService(
      { create } as unknown as Model<CustomerDocument>,
      {} as Model<OrderDocument>,
      {} as Model<ProductionJobDocument>,
      {} as Model<UploadDocument>,
    );

    await service.create({
      displayName: 'Multiple phones',
      phoneNumbers: ['02-7385801', '02-31660369', '02-7385801'],
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumber: '02-7385801',
        phoneNumbers: ['02-7385801', '02-31660369'],
      }),
    );
  });

  it('clears nullable profile fields explicitly while preserving PATCH semantics for omitted fields', async () => {
    const customerId = new Types.ObjectId();
    const exec = jest.fn().mockResolvedValue({
      _id: customerId,
      customerCode: 'CUS-1',
      displayName: 'Customer',
    });
    let capturedUpdate: unknown;
    const findByIdAndUpdate = jest.fn((_id: unknown, update: unknown) => {
      capturedUpdate = update;
      return { exec };
    });
    const service = new CustomersService(
      { findByIdAndUpdate } as unknown as Model<CustomerDocument>,
      {} as Model<OrderDocument>,
      {} as Model<ProductionJobDocument>,
      {} as Model<UploadDocument>,
    );

    await service.update(String(customerId), {
      email: null,
      companyName: null,
      phoneNumbers: [],
    } as unknown as Parameters<CustomersService['update']>[1]);

    expect(findByIdAndUpdate).toHaveBeenCalledTimes(1);
    const update = capturedUpdate as {
      $set?: Record<string, unknown>;
      $unset?: Record<string, unknown>;
    };
    expect(update.$set?.phoneNumbers).toEqual([]);
    expect(update.$set).not.toHaveProperty('email');
    expect(update.$set).not.toHaveProperty('companyName');
    expect(update.$unset).toEqual({
      email: 1,
      companyName: 1,
      phoneNumber: 1,
    });
  });

  it('derives related work from the full customer Order set instead of the 100-row history slice', async () => {
    const customerId = new Types.ObjectId();
    const recentOrderIds = Array.from(
      { length: 100 },
      () => new Types.ObjectId(),
    );
    const olderOrderId = new Types.ObjectId();
    const customerFind = chainResult({
      _id: customerId,
      customerCode: 'CUS-1',
      displayName: 'ลูกค้าประจำ',
    });
    const orderFind = chainResult(
      recentOrderIds.map((orderId, index) => ({
        _id: orderId,
        orderNumber: `OR-${index + 1}`,
        remainingTotal: 0,
        status: 'paid',
      })),
    );
    const summaryAggregate = {
      exec: jest
        .fn()
        .mockResolvedValue([{ orderCount: 101, outstandingTotal: 125.5 }]),
    };
    const jobsAggregate = {
      exec: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          orderId: olderOrderId,
          jobNumber: 'PJ-OLDER',
          stage: 'producing',
        },
      ]),
    };
    const uploadsAggregate = {
      exec: jest.fn().mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          linkedOrderId: String(olderOrderId),
          orderCode: 'GL-OLDER',
        },
      ]),
    };
    const capturedPipelines: Array<Array<Record<string, unknown>>> = [];
    const aggregateResults = [
      summaryAggregate,
      jobsAggregate,
      uploadsAggregate,
    ];
    const aggregate = jest.fn((pipeline: Array<Record<string, unknown>>) => {
      capturedPipelines.push(pipeline);
      return aggregateResults[capturedPipelines.length - 1];
    });
    const service = new CustomersService(
      {
        findById: jest.fn().mockReturnValue(customerFind),
      } as unknown as Model<CustomerDocument>,
      {
        find: jest.fn().mockReturnValue(orderFind),
        aggregate,
      } as unknown as Model<OrderDocument>,
      {
        collection: { name: 'productionjobs' },
      } as unknown as Model<ProductionJobDocument>,
      {
        collection: { name: 'uploads' },
      } as unknown as Model<UploadDocument>,
    );

    const detail = await service.detail(String(customerId));

    expect(detail.orders).toHaveLength(100);
    expect(detail.summary).toEqual({
      orderCount: 101,
      outstandingTotal: 125.5,
    });
    expect(detail.activeProductionJobs).toEqual([
      expect.objectContaining({ jobNumber: 'PJ-OLDER', orderId: olderOrderId }),
    ]);
    expect(detail.linkedUploads).toEqual([
      expect.objectContaining({
        orderCode: 'GL-OLDER',
        linkedOrderId: String(olderOrderId),
      }),
    ]);
    expect(detail.customer).not.toHaveProperty('outstandingTotal');

    const jobsPipeline = capturedPipelines[1] ?? [];
    const uploadsPipeline = capturedPipelines[2] ?? [];
    expect(jobsPipeline[0]).toEqual({ $match: { customerId } });
    expect(uploadsPipeline[0]).toEqual({ $match: { customerId } });
    expect(JSON.stringify(jobsPipeline)).not.toContain('$limit');
    expect(JSON.stringify(uploadsPipeline)).not.toContain('$limit');
    expect(JSON.stringify(jobsPipeline)).toContain('productionjobs');
    expect(JSON.stringify(uploadsPipeline)).toContain('uploads');
  });

  it('lists only fields matched through explicit server search and pagination', async () => {
    let capturedFilter: unknown;
    const findResult = chainResult([
      { customerCode: 'CUS-1', displayName: 'Acme' },
    ]);
    const find = jest.fn((filter: unknown) => {
      capturedFilter = filter;
      return findResult;
    });
    const countDocuments = jest.fn().mockResolvedValue(1);
    const service = new CustomersService(
      { find, countDocuments } as unknown as Model<CustomerDocument>,
      {} as Model<OrderDocument>,
      {} as Model<ProductionJobDocument>,
      {} as Model<UploadDocument>,
    );

    const result = await service.list({
      search: 'Acme',
      active: true,
      page: 2,
      limit: 10,
    });

    expect(JSON.stringify(capturedFilter)).toContain('displayName');
    expect(JSON.stringify(capturedFilter)).toContain('companyName');
    expect(JSON.stringify(capturedFilter)).toContain('phoneNumbers');
    expect(JSON.stringify(capturedFilter)).toContain('"active":true');
    expect(findResult.skip).toHaveBeenCalledWith(10);
    expect(result.total).toBe(1);
  });
});
