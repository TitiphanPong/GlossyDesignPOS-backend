import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { OrderDocument } from './orders.schema';
import { OrdersSseService } from './orders.sse.service';
import { OrdersService } from './orders.service';

type FindByIdAndUpdateArgs = [
  string,
  Record<string, unknown>,
  Record<string, unknown>,
];

type OrderModelLike = {
  findByIdAndUpdate: (...args: FindByIdAndUpdateArgs) => {
    exec: () => Promise<unknown>;
  };
};

describe('OrdersService', () => {
  const validOrderId = '61a1c287e53a7024d4ab8142';
  const runningNumberService = {
    generateOrderNumber: jest.fn(),
  } as unknown as RunningNumberService;

  const ordersSse = {
    emitOrder: jest.fn(),
    emitOrderAndAutoClear: jest.fn(),
  } as unknown as OrdersSseService;

  let findByIdAndUpdate: jest.MockedFunction<
    OrderModelLike['findByIdAndUpdate']
  >;
  let service: OrdersService;

  beforeEach(() => {
    findByIdAndUpdate = jest.fn();

    const orderModel: OrderModelLike = {
      findByIdAndUpdate,
    };

    service = new OrdersService(
      orderModel as unknown as Model<OrderDocument>,
      runningNumberService,
      ordersSse,
    );
  });

  it('updates only invoice customer fields and mirrors legacy aliases', async () => {
    const updatedAt = new Date('2026-05-31T00:00:00.000Z');
    const createdAt = new Date('2026-05-30T00:00:00.000Z');
    const updatedOrder = {
      _id: { toString: () => validOrderId },
      toObject: () => ({
        orderId: validOrderId,
        orderNumber: 'GL-20260531-0001',
        customerName: 'Sarayut 111',
        phoneNumber: '0812345678',
        note: 'keep original',
        total: 1200,
        discount: 0,
        depositTotal: 0,
        remainingTotal: 1200,
        payment: 'cash',
        status: 'pending',
        taxInvoice: 'yes',
        vatAmount: 78.5,
        grandTotal: 1278.5,
        payments: [],
        cart: [{ name: 'Card', qty: 1, unitPrice: 1200, totalPrice: 1200 }],
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        createdAt,
        updatedAt,
      }),
    };

    findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(updatedOrder),
    });

    const result = await service.updateCustomerInfo(validOrderId, {
      customerName: 'Sarayut 111',
      taxId: '0123456789012',
      address: '88/8 Moo Baan Klang Muang',
    });

    expect(findByIdAndUpdate).toHaveBeenCalledWith(
      validOrderId,
      {
        customerName: 'Sarayut 111',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
      },
      { new: true, runValidators: true },
    );
    expect(result).toEqual(
      expect.objectContaining({
        _id: validOrderId,
        customerName: 'Sarayut 111',
        taxId: '0123456789012',
        customerTaxId: '0123456789012',
        address: '88/8 Moo Baan Klang Muang',
        customerAddress: '88/8 Moo Baan Klang Muang',
        total: 1200,
        status: 'pending',
      }),
    );
  });

  it('throws 404 when order does not exist', async () => {
    findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.updateCustomerInfo(validOrderId, {
        customerName: 'Missing Customer',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws 400 when mirrored fields conflict', async () => {
    await expect(
      service.updateCustomerInfo(validOrderId, {
        taxId: '0123456789012',
        customerTaxId: '9999999999999',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
