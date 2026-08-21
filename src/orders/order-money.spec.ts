import { BadRequestException } from '@nestjs/common';
import {
  calculateOrderMoney,
  toMinorUnits,
  type PricedOrderLine,
} from './order-money';

const line = (unitPrice: number, quantity = 1): PricedOrderLine => ({
  quantity,
  unitPrice,
});

describe('order money invariants', () => {
  it('adds VAT 7% only for a tax invoice', () => {
    expect(
      calculateOrderMoney([line(100)], undefined, undefined, 'no'),
    ).toEqual(
      expect.objectContaining({
        subtotal: 100,
        discount: 0,
        vatAmount: 0,
        grandTotal: 100,
        paidAmount: 0,
        remainingTotal: 100,
        status: 'awaiting_payment',
      }),
    );
    expect(
      calculateOrderMoney([line(100)], undefined, undefined, 'yes'),
    ).toEqual(
      expect.objectContaining({
        subtotal: 100,
        discount: 0,
        vatAmount: 7,
        grandTotal: 107,
        paidAmount: 0,
        remainingTotal: 107,
        status: 'awaiting_payment',
      }),
    );
  });

  it('calculates amount and percentage discounts before VAT', () => {
    expect(
      calculateOrderMoney(
        [line(100)],
        { type: 'amount', value: 10 },
        undefined,
        'yes',
      ),
    ).toEqual(
      expect.objectContaining({
        discount: 10,
        vatAmount: 6.3,
        grandTotal: 96.3,
      }),
    );

    expect(
      calculateOrderMoney(
        [line(350)],
        { type: 'percent', value: 10 },
        undefined,
        'yes',
      ),
    ).toEqual(
      expect.objectContaining({
        discount: 35,
        vatAmount: 22.05,
        grandTotal: 337.05,
      }),
    );
  });

  it('rejects a discount greater than subtotal', () => {
    expect(() =>
      calculateOrderMoney(
        [line(100)],
        { type: 'amount', value: 100.01 },
        undefined,
        'no',
      ),
    ).toThrow(BadRequestException);
  });

  it.each([
    { quantity: 0, unitPrice: 10 },
    { quantity: -1, unitPrice: 10 },
    { quantity: 1, unitPrice: 0 },
    { quantity: 1, unitPrice: -0.01 },
  ])('rejects zero or negative quantity/price: %p', (invalidLine) => {
    expect(() =>
      calculateOrderMoney([invalidLine], undefined, undefined, 'no'),
    ).toThrow(BadRequestException);
  });

  it('derives paid, remaining, change and financial status from payment facts', () => {
    expect(
      calculateOrderMoney(
        [line(100)],
        undefined,
        {
          amount: 40,
          method: 'cash',
          receivedAmount: 50,
        },
        'yes',
      ),
    ).toEqual(
      expect.objectContaining({
        grandTotal: 107,
        paidAmount: 40,
        remainingTotal: 67,
        changeAmount: 10,
        status: 'partial',
      }),
    );

    expect(
      calculateOrderMoney(
        [line(100)],
        undefined,
        {
          amount: 107,
          method: 'promptpay',
        },
        'yes',
      ).status,
    ).toBe('paid');
  });

  it('keeps all arithmetic in whole satang across representative values', () => {
    for (let satang = 1; satang <= 10_000; satang += 37) {
      const value = satang / 100;
      const result = calculateOrderMoney(
        [line(value, 3)],
        { type: 'percent', value: 12.5 },
        undefined,
        'yes',
      );

      expect(toMinorUnits(result.subtotal, 'subtotal')).toBe(satang * 3);
      expect(Number.isInteger(toMinorUnits(result.discount, 'discount'))).toBe(
        true,
      );
      expect(toMinorUnits(result.grandTotal, 'grandTotal')).toBe(
        toMinorUnits(result.subtotal, 'subtotal') -
          toMinorUnits(result.discount, 'discount') +
          toMinorUnits(result.vatAmount, 'vatAmount'),
      );
    }
  });
});
