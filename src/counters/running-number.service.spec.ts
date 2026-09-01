import { Model } from 'mongoose';
import { CounterDocument } from './counters.schema';
import { RunningNumberService } from './running-number.service';

describe('RunningNumberService', () => {
  const sequences = new Map<string, number>();
  const counterModel = {
    findOneAndUpdate: jest.fn((filter: { type: string; year: number }) => {
      const key = `${filter.type}-${filter.year}`;
      const seq = (sequences.get(key) ?? 0) + 1;
      sequences.set(key, seq);
      return Promise.resolve({ seq });
    }),
  } as unknown as Model<CounterDocument>;

  const service = new RunningNumberService(counterModel);

  beforeEach(() => {
    sequences.clear();
    jest.clearAllMocks();
  });

  it('keeps August 2026 separate and starts the continuous sequence in September', async () => {
    const august = await service.generateTaxInvoiceNumber(
      new Date('2026-08-31T16:59:59.000Z'),
    );
    const september = await service.generateTaxInvoiceNumber(
      new Date('2026-08-31T17:00:00.000Z'),
    );
    const october = await service.generateTaxInvoiceNumber(
      new Date('2026-09-30T17:00:00.000Z'),
    );
    const nextYear = await service.generateTaxInvoiceNumber(
      new Date('2026-12-31T17:00:00.000Z'),
    );

    expect(august).toEqual({
      invoiceNumber: 'INV-202608-001-001',
      bookNo: '001',
      invoiceSequence: '001',
      invoicePeriod: '202608',
    });
    expect(september).toEqual({
      invoiceNumber: 'INV-202609-001-001',
      bookNo: '001',
      invoiceSequence: '001',
      invoicePeriod: '202609',
    });
    expect(october).toEqual({
      invoiceNumber: 'INV-202610-001-002',
      bookNo: '001',
      invoiceSequence: '002',
      invoicePeriod: '202610',
    });
    expect(nextYear).toEqual({
      invoiceNumber: 'INV-202701-001-003',
      bookNo: '001',
      invoiceSequence: '003',
      invoicePeriod: '202701',
    });
  });

  it('starts a new book after 100 invoices even when the sequence crosses a month', async () => {
    const september = new Date('2026-09-01T00:00:00.000Z');
    const october = new Date('2026-10-01T00:00:00.000Z');
    let allocated;

    for (let index = 0; index < 100; index += 1) {
      allocated = await service.generateTaxInvoiceNumber(september);
    }

    expect(allocated).toEqual({
      invoiceNumber: 'INV-202609-001-100',
      bookNo: '001',
      invoiceSequence: '100',
      invoicePeriod: '202609',
    });

    allocated = await service.generateTaxInvoiceNumber(october);

    expect(allocated).toEqual({
      invoiceNumber: 'INV-202610-002-001',
      bookNo: '002',
      invoiceSequence: '001',
      invoicePeriod: '202610',
    });
  });
});
