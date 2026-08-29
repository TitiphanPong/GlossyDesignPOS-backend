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

  it('derives detail aggregates from authoritative linked records without copying them into customer data', async () => {
    const customerId = new Types.ObjectId();
    const orderId = new Types.ObjectId();
    const customerFind = chainResult({
      _id: customerId,
      customerCode: 'CUS-1',
      displayName: 'ลูกค้าประจำ',
    });
    const orderFind = chainResult([
      {
        _id: orderId,
        orderNumber: 'OR-1',
        remainingTotal: 125.5,
        status: 'partial',
      },
      {
        _id: new Types.ObjectId(),
        orderNumber: 'OR-2',
        remainingTotal: 500,
        status: 'cancelled',
      },
    ]);
    const jobFind = chainResult([
      {
        _id: new Types.ObjectId(),
        orderId,
        jobNumber: 'PJ-1',
        stage: 'producing',
      },
    ]);
    const uploadFind = chainResult([
      {
        _id: new Types.ObjectId(),
        linkedOrderId: String(orderId),
        orderCode: 'GL-1',
      },
    ]);
    const service = new CustomersService(
      {
        findById: jest.fn().mockReturnValue(customerFind),
      } as unknown as Model<CustomerDocument>,
      {
        find: jest.fn().mockReturnValue(orderFind),
      } as unknown as Model<OrderDocument>,
      {
        find: jest.fn().mockReturnValue(jobFind),
      } as unknown as Model<ProductionJobDocument>,
      {
        find: jest.fn().mockReturnValue(uploadFind),
      } as unknown as Model<UploadDocument>,
    );

    const detail = await service.detail(String(customerId));

    expect(detail.summary).toEqual({ orderCount: 2, outstandingTotal: 125.5 });
    expect(detail.activeProductionJobs).toHaveLength(1);
    expect(detail.linkedUploads).toHaveLength(1);
    expect(detail.customer).not.toHaveProperty('outstandingTotal');
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
    expect(JSON.stringify(capturedFilter)).toContain('phoneNumbers');
    expect(JSON.stringify(capturedFilter)).toContain('"active":true');
    expect(findResult.skip).toHaveBeenCalledWith(10);
    expect(result.total).toBe(1);
  });
});
