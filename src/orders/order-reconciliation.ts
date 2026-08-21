import { calculateOrderMoney, toMinorUnits } from './order-money';

export type LegacyOrderRecord = {
  _id?: unknown;
  orderId?: unknown;
  orderNumber?: unknown;
  cart?: Array<{
    qty?: unknown;
    quantity?: unknown;
    unitPrice?: unknown;
    price?: unknown;
    totalPrice?: unknown;
    lineTotal?: unknown;
  }>;
  subtotal?: unknown;
  total?: unknown;
  discount?: unknown;
  vatAmount?: unknown;
  grandTotal?: unknown;
  paidAmount?: unknown;
  depositTotal?: unknown;
  remainingTotal?: unknown;
  status?: unknown;
  taxInvoice?: unknown;
};

export type ReconciliationResult = {
  identity: string;
  outcome: 'reconciled' | 'mismatch' | 'manual_review';
  catalogPriceVerification: 'not_verified_from_export';
  expected?: Record<string, number | string>;
  differences: Array<{ field: string; stored: unknown; expected: unknown }>;
  issues: string[];
};

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function equalMoney(left: unknown, right: number): boolean {
  try {
    return (
      toMinorUnits(numberOrZero(left), 'stored money') ===
      toMinorUnits(right, 'expected money')
    );
  } catch {
    return false;
  }
}

export function reconcileLegacyOrder(
  order: LegacyOrderRecord,
): ReconciliationResult {
  const rawIdentity = order.orderNumber ?? order.orderId ?? order._id;
  const identity =
    typeof rawIdentity === 'string' || typeof rawIdentity === 'number'
      ? `${rawIdentity}`
      : 'unknown';
  const issues: string[] = [];
  const differences: ReconciliationResult['differences'] = [];

  const lines = (order.cart ?? []).map((item, index) => {
    const quantity = numberOrZero(item.qty ?? item.quantity);
    const unitPrice = numberOrZero(item.unitPrice ?? item.price);
    const storedLineTotal = item.totalPrice ?? item.lineTotal;
    const expectedLineTotal = Math.round(unitPrice * quantity * 100) / 100;
    if (!equalMoney(storedLineTotal, expectedLineTotal)) {
      differences.push({
        field: `cart.${index}.lineTotal`,
        stored: storedLineTotal,
        expected: expectedLineTotal,
      });
    }
    return { quantity, unitPrice };
  });

  try {
    const paidAmount = numberOrZero(order.paidAmount ?? order.depositTotal);
    const calculated = calculateOrderMoney(
      lines,
      { type: 'amount', value: numberOrZero(order.discount) },
      paidAmount > 0 ? { amount: paidAmount, method: 'cash' } : undefined,
      order.taxInvoice === 'yes' ? 'yes' : 'no',
    );
    const expected: Record<string, number | string> = {
      subtotal: calculated.subtotal,
      discount: calculated.discount,
      vatAmount: calculated.vatAmount,
      grandTotal: calculated.grandTotal,
      paidAmount: calculated.paidAmount,
      remainingTotal: calculated.remainingTotal,
      status: calculated.status,
    };
    const storedFields: Record<string, unknown> = {
      subtotal: order.subtotal ?? order.total,
      discount: order.discount,
      vatAmount: order.vatAmount,
      grandTotal: order.grandTotal,
      paidAmount: order.paidAmount ?? order.depositTotal,
      remainingTotal: order.remainingTotal,
    };

    for (const [field, expectedValue] of Object.entries(expected)) {
      if (field === 'status') {
        if (order.status !== expectedValue) {
          differences.push({
            field,
            stored: order.status,
            expected: expectedValue,
          });
        }
      } else if (!equalMoney(storedFields[field], expectedValue as number)) {
        differences.push({
          field,
          stored: storedFields[field],
          expected: expectedValue,
        });
      }
    }

    return {
      identity,
      outcome: differences.length ? 'mismatch' : 'reconciled',
      catalogPriceVerification: 'not_verified_from_export',
      expected,
      differences,
      issues,
    };
  } catch (error) {
    issues.push(
      error instanceof Error
        ? error.message
        : 'Unable to calculate legacy order.',
    );
    return {
      identity,
      outcome: 'manual_review',
      catalogPriceVerification: 'not_verified_from_export',
      differences,
      issues,
    };
  }
}

export function reconcileLegacyOrders(orders: LegacyOrderRecord[]) {
  const results = orders.map(reconcileLegacyOrder);
  return {
    generatedAt: new Date().toISOString(),
    mode: 'read_only_export',
    total: results.length,
    reconciled: results.filter((result) => result.outcome === 'reconciled')
      .length,
    mismatched: results.filter((result) => result.outcome === 'mismatch')
      .length,
    manualReview: results.filter((result) => result.outcome === 'manual_review')
      .length,
    results,
  };
}
