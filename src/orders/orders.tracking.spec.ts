import { createHash } from 'node:crypto';
import { Connection, Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderPricingService } from './order-pricing.service';
import { OrderReportingService } from './order-reporting.service';
import type { ProductionJobDocument } from '../production/schemas/production-job.schema';
import type { OrderDocument } from './orders.schema';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';

function makeService(
  orderModel: Model<OrderDocument>,
  productionJobModel?: Model<ProductionJobDocument>,
): OrdersService {
  return new OrdersService(
    orderModel,
    {} as RunningNumberService,
    {} as OrdersSseService,
    {} as OrderPricingService,
    undefined as unknown as OrderReportingService,
    {} as NotificationsService,
    {} as Connection,
    undefined,
    productionJobModel,
  );
}

describe('OrdersService public tracking lookup', () => {
  it('uses exact order identity plus phone suffix and returns customer-safe milestones only', async () => {
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: { toString: () => '61a1c287e53a7024d4ab8142' },
        toObject: () => ({
          orderId: 'legacy-001',
          orderNumber: 'GD-2026-000001',
          customerName: 'Must not be exposed',
          phoneNumber: '0812345678',
          status: 'producing',
          statusHistory: [
            {
              status: 'pending',
              note: 'Internal note must not leak',
              changedBy: 'internal-user-id',
              changedAt: new Date('2026-08-27T00:00:00.000Z'),
            },
            {
              status: 'partial',
              note: 'Financial state is internal',
              changedAt: new Date('2026-08-27T00:30:00.000Z'),
            },
            {
              status: 'producing',
              changedAt: new Date('2026-08-27T01:00:00.000Z'),
            },
          ],
          total: 999,
          grandTotal: 999,
          cart: [{ name: 'Private job detail' }],
          createdAt: new Date('2026-08-27T00:00:00.000Z'),
          updatedAt: new Date('2026-08-27T01:00:00.000Z'),
        }),
      }),
    });
    const service = makeService({ findOne } as unknown as Model<OrderDocument>);

    const result = await service.lookupPublicTracking(
      ' GD-2026-000001 ',
      '5678',
    );

    expect(findOne).toHaveBeenCalledWith({
      $and: [
        {
          $or: [
            { orderNumber: 'GD-2026-000001' },
            { orderId: 'GD-2026-000001' },
          ],
        },
        { phoneNumber: { $regex: '5678$' } },
      ],
    });
    expect(result).toEqual({
      orderNumber: 'GD-2026-000001',
      currentMilestone: 'in_progress',
      milestones: [
        {
          milestone: 'received',
          reachedAt: new Date('2026-08-27T00:00:00.000Z'),
        },
        {
          milestone: 'in_progress',
          reachedAt: new Date('2026-08-27T01:00:00.000Z'),
        },
      ],
      updatedAt: new Date('2026-08-27T01:00:00.000Z'),
    });
    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('customerName');
    expect(result).not.toHaveProperty('phoneNumber');
    expect(result).not.toHaveProperty('cart');
    expect(result).not.toHaveProperty('grandTotal');
    expect(result?.milestones.every((entry) => !('note' in entry))).toBe(true);
    expect(result?.milestones.every((entry) => !('changedBy' in entry))).toBe(
      true,
    );
  });

  it('does not let financial statuses overwrite the latest customer workflow milestone', async () => {
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: { toString: () => '61a1c287e53a7024d4ab8142' },
        toObject: () => ({
          orderNumber: 'GD-2026-000002',
          phoneNumber: '0812345678',
          status: 'paid',
          statusHistory: [
            {
              status: 'pending',
              changedAt: new Date('2026-08-27T00:00:00.000Z'),
            },
            {
              status: 'ready_for_pickup',
              changedAt: new Date('2026-08-27T02:00:00.000Z'),
            },
            {
              status: 'paid',
              changedAt: new Date('2026-08-27T03:00:00.000Z'),
            },
          ],
          createdAt: new Date('2026-08-27T00:00:00.000Z'),
          updatedAt: new Date('2026-08-27T03:00:00.000Z'),
        }),
      }),
    });
    const service = makeService({ findOne } as unknown as Model<OrderDocument>);

    const result = await service.lookupPublicTracking('GD-2026-000002', '5678');

    expect(result?.currentMilestone).toBe('ready');
    expect(result?.milestones.map((entry) => entry.milestone)).toEqual([
      'received',
      'ready',
    ]);
  });

  it('looks up secure tracking access by token hash and returns only public milestones', async () => {
    const token = 'A'.repeat(43);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: { toString: () => '61a1c287e53a7024d4ab8142' },
        toObject: () => ({
          orderNumber: 'GD-2026-000003',
          phoneNumber: '',
          status: 'paid',
          workflowStatus: 'producing',
          statusHistory: [
            {
              status: 'pending',
              changedAt: new Date('2026-08-27T00:00:00.000Z'),
            },
            {
              status: 'producing',
              changedAt: new Date('2026-08-27T01:00:00.000Z'),
            },
          ],
          grandTotal: 999,
          createdAt: new Date('2026-08-27T00:00:00.000Z'),
          updatedAt: new Date('2026-08-27T03:00:00.000Z'),
        }),
      }),
    });
    const service = makeService({ findOne } as unknown as Model<OrderDocument>);

    const result = await service.lookupPublicTrackingByToken(token);

    expect(findOne).toHaveBeenCalledWith({
      trackingAccessTokenHash: tokenHash,
    });
    expect(result).toEqual({
      orderNumber: 'GD-2026-000003',
      currentMilestone: 'in_progress',
      milestones: [
        {
          milestone: 'received',
          reachedAt: new Date('2026-08-27T00:00:00.000Z'),
        },
        {
          milestone: 'in_progress',
          reachedAt: new Date('2026-08-27T01:00:00.000Z'),
        },
      ],
      updatedAt: new Date('2026-08-27T01:00:00.000Z'),
    });
    expect(result).not.toHaveProperty('phoneNumber');
    expect(result).not.toHaveProperty('grandTotal');
  });

  it('keeps a multi-job order in progress until every sibling job is ready-or-later', async () => {
    const orderId = '61a1c287e53a7024d4ab8142';
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: orderId,
        toObject: () => ({
          orderNumber: 'GD-2026-000004',
          phoneNumber: '0812345678',
          status: 'ready_for_pickup',
          workflowStatus: 'ready_for_pickup',
          statusHistory: [
            {
              status: 'pending',
              changedAt: new Date('2026-08-27T00:00:00.000Z'),
            },
            {
              status: 'ready_for_pickup',
              changedAt: new Date('2026-08-27T03:00:00.000Z'),
            },
          ],
          createdAt: new Date('2026-08-27T00:00:00.000Z'),
          updatedAt: new Date('2026-08-27T03:00:00.000Z'),
        }),
      }),
    });
    const productionExec = jest.fn().mockResolvedValue([
      {
        stage: 'ready',
        stageHistory: [
          {
            stage: 'producing',
            changedAt: new Date('2026-08-27T01:00:00.000Z'),
          },
          {
            stage: 'ready',
            changedAt: new Date('2026-08-27T02:00:00.000Z'),
          },
        ],
      },
      {
        stage: 'queued',
        stageHistory: [
          {
            stage: 'queued',
            changedAt: new Date('2026-08-27T00:30:00.000Z'),
          },
        ],
      },
    ]);
    const lean = jest.fn().mockReturnValue({ exec: productionExec });
    const select = jest.fn().mockReturnValue({ lean });
    const find = jest.fn().mockReturnValue({ select });
    const service = makeService(
      { findOne } as unknown as Model<OrderDocument>,
      { find } as unknown as Model<ProductionJobDocument>,
    );

    const result = await service.lookupPublicTracking('GD-2026-000004', '5678');

    expect(find).toHaveBeenCalledWith({ orderId });
    expect(result?.currentMilestone).toBe('in_progress');
    expect(result?.milestones.map((entry) => entry.milestone)).toEqual([
      'received',
      'in_progress',
    ]);
  });

  it('projects ready only when every production job is ready-or-later using the last sibling readiness time', async () => {
    const orderId = '61a1c287e53a7024d4ab8142';
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: orderId,
        toObject: () => ({
          orderNumber: 'GD-2026-000005',
          phoneNumber: '0812345678',
          status: 'producing',
          workflowStatus: 'producing',
          statusHistory: [
            {
              status: 'pending',
              changedAt: new Date('2026-08-27T00:00:00.000Z'),
            },
          ],
          createdAt: new Date('2026-08-27T00:00:00.000Z'),
          updatedAt: new Date('2026-08-27T04:00:00.000Z'),
        }),
      }),
    });
    const productionExec = jest.fn().mockResolvedValue([
      {
        stage: 'delivered',
        stageHistory: [
          {
            stage: 'producing',
            changedAt: new Date('2026-08-27T01:00:00.000Z'),
          },
          {
            stage: 'ready',
            changedAt: new Date('2026-08-27T02:00:00.000Z'),
          },
          {
            stage: 'delivered',
            changedAt: new Date('2026-08-27T02:30:00.000Z'),
          },
        ],
      },
      {
        stage: 'ready',
        stageHistory: [
          {
            stage: 'producing',
            changedAt: new Date('2026-08-27T01:30:00.000Z'),
          },
          {
            stage: 'ready',
            changedAt: new Date('2026-08-27T03:00:00.000Z'),
          },
        ],
      },
    ]);
    const lean = jest.fn().mockReturnValue({ exec: productionExec });
    const select = jest.fn().mockReturnValue({ lean });
    const find = jest.fn().mockReturnValue({ select });
    const service = makeService(
      { findOne } as unknown as Model<OrderDocument>,
      { find } as unknown as Model<ProductionJobDocument>,
    );

    const result = await service.lookupPublicTracking('GD-2026-000005', '5678');

    expect(result).toEqual({
      orderNumber: 'GD-2026-000005',
      currentMilestone: 'ready',
      milestones: [
        {
          milestone: 'received',
          reachedAt: new Date('2026-08-27T00:00:00.000Z'),
        },
        {
          milestone: 'in_progress',
          reachedAt: new Date('2026-08-27T01:00:00.000Z'),
        },
        {
          milestone: 'ready',
          reachedAt: new Date('2026-08-27T03:00:00.000Z'),
        },
      ],
      updatedAt: new Date('2026-08-27T03:00:00.000Z'),
    });
  });

  it('returns null instead of leaking whether only the order number matched', async () => {
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });
    const service = makeService({ findOne } as unknown as Model<OrderDocument>);

    await expect(
      service.lookupPublicTracking('GD-2026-000001', '9999'),
    ).resolves.toBeNull();
  });
});
