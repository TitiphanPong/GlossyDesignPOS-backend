export const TAX_INVOICE_CONTINUOUS_SEQUENCE_START_PERIOD = '202609';

export const INVOICES_PER_BOOK = 100;

export function getTaxInvoiceCounterPeriod(invoicePeriod: string): number {
  if (!/^\d{6}$/.test(invoicePeriod)) {
    throw new TypeError(`Invalid tax invoice period "${invoicePeriod}".`);
  }

  return Number(
    invoicePeriod >= TAX_INVOICE_CONTINUOUS_SEQUENCE_START_PERIOD
      ? TAX_INVOICE_CONTINUOUS_SEQUENCE_START_PERIOD
      : invoicePeriod,
  );
}

export function getTaxInvoiceBookSequence(totalSequence: number): {
  bookNo: string;
  invoiceSequence: string;
} {
  if (!Number.isSafeInteger(totalSequence) || totalSequence < 1) {
    throw new TypeError(
      'Tax invoice sequence must be a positive safe integer.',
    );
  }

  const bookNumber = Math.floor((totalSequence - 1) / INVOICES_PER_BOOK) + 1;
  const invoiceNumber = ((totalSequence - 1) % INVOICES_PER_BOOK) + 1;

  return {
    bookNo: bookNumber.toString().padStart(3, '0'),
    invoiceSequence: invoiceNumber.toString().padStart(3, '0'),
  };
}
