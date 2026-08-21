import { BadRequestException } from '@nestjs/common';
import type { OrderStatus, PaymentMethod } from './orders.schema';

export type PricedOrderLine = {
  quantity: number;
  unitPrice: number;
};

export type OrderDiscount = {
  type: 'amount' | 'percent';
  value: number;
};

export type InitialPayment = {
  amount: number;
  method: PaymentMethod;
  receivedAmount?: number;
};

export type CalculatedOrderMoney = {
  subtotal: number;
  discount: number;
  vatAmount: number;
  grandTotal: number;
  paidAmount: number;
  remainingTotal: number;
  receivedAmount?: number;
  changeAmount: number;
  status: Extract<OrderStatus, 'awaiting_payment' | 'partial' | 'paid'>;
};

const MINOR_UNIT_FACTOR = 100;
const VAT_PERCENT = 7;
const PERCENT_BASIS = 10_000;

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new BadRequestException(
      `${field} must be a finite non-negative amount.`,
    );
  }
}

export function toMinorUnits(value: number, field: string): number {
  assertFiniteNonNegative(value, field);
  const minorUnits = Math.round((value + Number.EPSILON) * MINOR_UNIT_FACTOR);
  if (!Number.isSafeInteger(minorUnits)) {
    throw new BadRequestException(
      `${field} is outside the supported money range.`,
    );
  }
  return minorUnits;
}

export function fromMinorUnits(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(
      'Money invariant requires whole non-negative minor units.',
    );
  }
  return value / MINOR_UNIT_FACTOR;
}

function calculateDiscountMinor(
  subtotalMinor: number,
  discount?: OrderDiscount,
): number {
  if (!discount) return 0;
  assertFiniteNonNegative(discount.value, 'discount.value');

  if (discount.type === 'amount') {
    return toMinorUnits(discount.value, 'discount.value');
  }

  if (discount.value > 100) {
    throw new BadRequestException('Percentage discount cannot exceed 100.');
  }
  const basisPoints = Math.round((discount.value + Number.EPSILON) * 100);
  return Math.round((subtotalMinor * basisPoints) / PERCENT_BASIS);
}

export function calculateOrderMoney(
  lines: PricedOrderLine[],
  discount?: OrderDiscount,
  initialPayment?: InitialPayment,
  taxInvoice: 'yes' | 'no' = 'no',
): CalculatedOrderMoney {
  if (!lines.length) {
    throw new BadRequestException('Order cart must contain at least one item.');
  }

  const subtotalMinor = lines.reduce((sum, line, index) => {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) {
      throw new BadRequestException(
        `cart.${index}.quantity must be a positive integer.`,
      );
    }
    const unitPriceMinor = toMinorUnits(
      line.unitPrice,
      `cart.${index}.unitPrice`,
    );
    if (unitPriceMinor <= 0) {
      throw new BadRequestException(
        `cart.${index}.unitPrice must be greater than 0.`,
      );
    }
    const lineTotalMinor = unitPriceMinor * line.quantity;
    if (
      !Number.isSafeInteger(lineTotalMinor) ||
      !Number.isSafeInteger(sum + lineTotalMinor)
    ) {
      throw new BadRequestException(
        'Order subtotal is outside the supported money range.',
      );
    }
    return sum + lineTotalMinor;
  }, 0);

  const discountMinor = calculateDiscountMinor(subtotalMinor, discount);
  if (discountMinor > subtotalMinor) {
    throw new BadRequestException('Discount cannot exceed subtotal.');
  }

  const taxableMinor = subtotalMinor - discountMinor;
  const vatMinor =
    taxInvoice === 'yes' ? Math.round((taxableMinor * VAT_PERCENT) / 100) : 0;
  const grandTotalMinor = taxableMinor + vatMinor;
  const paidMinor = initialPayment
    ? toMinorUnits(initialPayment.amount, 'initialPayment.amount')
    : 0;

  if (paidMinor > grandTotalMinor) {
    throw new BadRequestException('Initial payment cannot exceed grand total.');
  }

  let receivedMinor: number | undefined;
  let changeMinor = 0;
  if (initialPayment?.receivedAmount !== undefined) {
    receivedMinor = toMinorUnits(
      initialPayment.receivedAmount,
      'initialPayment.receivedAmount',
    );
    if (receivedMinor < paidMinor) {
      throw new BadRequestException(
        'Received amount cannot be less than payment amount.',
      );
    }
    changeMinor = receivedMinor - paidMinor;
  }

  const remainingMinor = grandTotalMinor - paidMinor;
  const status: CalculatedOrderMoney['status'] =
    paidMinor === 0
      ? 'awaiting_payment'
      : remainingMinor === 0
        ? 'paid'
        : 'partial';

  return {
    subtotal: fromMinorUnits(subtotalMinor),
    discount: fromMinorUnits(discountMinor),
    vatAmount: fromMinorUnits(vatMinor),
    grandTotal: fromMinorUnits(grandTotalMinor),
    paidAmount: fromMinorUnits(paidMinor),
    remainingTotal: fromMinorUnits(remainingMinor),
    ...(receivedMinor === undefined
      ? {}
      : { receivedAmount: fromMinorUnits(receivedMinor) }),
    changeAmount: fromMinorUnits(changeMinor),
    status,
  };
}
