import { Connection, Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderPricingService } from './order-pricing.service';
import { OrderReportingService } from './order-reporting.service';
import type { OrderDocument } from './orders.schema';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';

function makeService(orderModel: Model<OrderDocument>): OrdersService {
  return new OrdersService(
    orderModel,
    {} as RunningNumberService,
    {} as OrdersSseService,
    {} as OrderPricingService,
    undefined as unknown as OrderReportingService,
    {} as NotificationsService,
    {} as Connection,
  );
}

describe('OrdersService public tracking lookup', () => {
  it('uses exact order identity plus phone suffix and returns minimal public fields', async () => {
    const findOne = jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue({
        _id: { toString: () => '61a1c287e53a7024d4ab8142' },
        toObject: () => ({
          orderId: 'legacy-001',
          orderNumber: 'GD-2026-000001',
          customerName: 'Must not be exposed',
          phoneNumber: '0812345678',
          status: 'producing',
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
      status: 'producing',
      createdAt: new Date('2026-08-27T00:00:00.000Z'),
      updatedAt: new Date('2026-08-27T01:00:00.000Z'),
    });
    expect(result).not.toHaveProperty('customerName');
    expect(result).not.toHaveProperty('phoneNumber');
    expect(result).not.toHaveProperty('cart');
    expect(result).not.toHaveProperty('grandTotal');
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
