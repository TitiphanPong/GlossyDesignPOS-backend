import { createHash } from 'node:crypto';
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

function selectable<T>(value: T) {
  return {
    select: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(value),
    }),
  };
}

describe('OrdersService tracking access', () => {
  const orderId = '61a1c287e53a7024d4ab8142';

  it('creates one high-entropy tracking token and stores its SHA-256 lookup hash', async () => {
    const findById = jest.fn().mockReturnValue(selectable({ _id: orderId }));
    const findOneAndUpdate = jest
      .fn()
      .mockImplementation(
        (_filter: unknown, update: { $set: { trackingAccessToken: string } }) =>
          selectable({
            _id: orderId,
            trackingAccessToken: update.$set.trackingAccessToken,
          }),
      );
    const service = makeService({
      findById,
      findOneAndUpdate,
    } as unknown as Model<OrderDocument>);

    const result = await service.getOrCreateTrackingAccessToken(orderId);

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [, update] = findOneAndUpdate.mock.calls[0] as [
      unknown,
      {
        $set: { trackingAccessToken: string; trackingAccessTokenHash: string };
      },
    ];
    expect(update.$set.trackingAccessToken).toBe(result.token);
    expect(update.$set.trackingAccessTokenHash).toBe(
      createHash('sha256').update(result.token).digest('hex'),
    );
  });

  it('reuses an existing tracking token instead of rotating customer QR access', async () => {
    const token = 'B'.repeat(43);
    const hash = createHash('sha256').update(token).digest('hex');
    const findById = jest.fn().mockReturnValue(
      selectable({
        _id: orderId,
        trackingAccessToken: token,
        trackingAccessTokenHash: hash,
      }),
    );
    const findByIdAndUpdate = jest.fn();
    const findOneAndUpdate = jest.fn();
    const service = makeService({
      findById,
      findByIdAndUpdate,
      findOneAndUpdate,
    } as unknown as Model<OrderDocument>);

    await expect(
      service.getOrCreateTrackingAccessToken(orderId),
    ).resolves.toEqual({
      token,
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
