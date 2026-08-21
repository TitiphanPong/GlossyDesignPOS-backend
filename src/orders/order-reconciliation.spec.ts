import { reconcileLegacyOrder } from './order-reconciliation';

describe('legacy financial reconciliation', () => {
  it('reports VAT-inclusive legacy differences without mutating the record', () => {
    const legacy = {
      orderNumber: 'LEGACY-1',
      cart: [{ qty: 1, unitPrice: 100, totalPrice: 100 }],
      subtotal: 100,
      discount: 0,
      vatAmount: 6.54,
      grandTotal: 100,
      paidAmount: 100,
      remainingTotal: 0,
      status: 'paid',
      taxInvoice: 'yes' as const,
    };
    const snapshot = structuredClone(legacy);

    const result = reconcileLegacyOrder(legacy);

    expect(result.outcome).toBe('mismatch');
    expect(result.expected).toEqual(
      expect.objectContaining({
        vatAmount: 7,
        grandTotal: 107,
        remainingTotal: 7,
        status: 'partial',
      }),
    );
    expect(result.differences.map((difference) => difference.field)).toEqual(
      expect.arrayContaining([
        'vatAmount',
        'grandTotal',
        'remainingTotal',
        'status',
      ]),
    );
    expect(legacy).toEqual(snapshot);
  });

  it('expects no VAT for a regular receipt', () => {
    const result = reconcileLegacyOrder({
      orderNumber: 'LEGACY-RECEIPT',
      cart: [{ qty: 1, unitPrice: 100, totalPrice: 100 }],
      subtotal: 100,
      discount: 0,
      vatAmount: 0,
      grandTotal: 100,
      paidAmount: 100,
      remainingTotal: 0,
      status: 'paid',
      taxInvoice: 'no',
    });

    expect(result.outcome).toBe('reconciled');
    expect(result.expected).toEqual(
      expect.objectContaining({ vatAmount: 0, grandTotal: 100 }),
    );
  });

  it('routes invalid legacy quantities and excessive discounts to manual review', () => {
    expect(
      reconcileLegacyOrder({
        orderNumber: 'LEGACY-BAD',
        cart: [{ qty: 0, unitPrice: 100, totalPrice: 0 }],
        discount: 500,
      }).outcome,
    ).toBe('manual_review');
  });
});
