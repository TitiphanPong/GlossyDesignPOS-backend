import { Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { OrderDocument } from './orders.schema';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';

describe('OrdersService public tracking', () => {
  const exec = jest.fn();
  const select = jest.fn(() => ({ exec }));
  const findOne = jest.fn(() => ({ select }));
  const service = new OrdersService(
    { findOne } as unknown as Model<OrderDocument>,
    {} as RunningNumberService,
    {} as OrdersSseService,
  );

  beforeEach(() => {
    exec.mockReset();
    select.mockClear();
    findOne.mockClear();
  });

  it('uses an exact order-number query and a minimal database projection', async () => {
    const createdAt = new Date('2026-08-12T01:00:00.000Z');
    const updatedAt = new Date('2026-08-12T02:00:00.000Z');
    exec.mockResolvedValue({
      phoneNumber: '081-234-5678',
      toObject: () => ({
        orderNumber: 'GD-000123',
        phoneNumber: '081-234-5678',
        status: 'producing',
        createdAt,
        updatedAt,
      }),
    });

    await expect(
      service.lookupPublicTracking(' GD-000123 ', '5678'),
    ).resolves.toEqual({
      orderNumber: 'GD-000123',
      status: 'producing',
      createdAt,
      updatedAt,
    });
    expect(findOne).toHaveBeenCalledWith({ orderNumber: 'GD-000123' });
    expect(select).toHaveBeenCalledWith(
      'orderNumber phoneNumber status createdAt updatedAt',
    );
  });

  it('returns no data when the phone verifier does not match', async () => {
    exec.mockResolvedValue({
      phoneNumber: '0812345678',
      toObject: jest.fn(),
    });

    await expect(
      service.lookupPublicTracking('GD-000123', '0000'),
    ).resolves.toBeNull();
  });
});
