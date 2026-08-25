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

  it('starts each Bangkok month at Book 001 and Invoice 001', async () => {
    const august = await service.generateTaxInvoiceNumber(
      new Date('2026-08-31T16:59:59.000Z'),
    );
    const september = await service.generateTaxInvoiceNumber(
      new Date('2026-08-31T17:00:00.000Z'),
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
  });

  it('starts a new book after 100 invoices in one month', async () => {
    const issuedAt = new Date('2026-08-25T10:00:00.000Z');
    let allocated;

    for (let index = 0; index < 101; index += 1) {
      allocated = await service.generateTaxInvoiceNumber(issuedAt);
    }

    expect(allocated).toEqual({
      invoiceNumber: 'INV-202608-002-001',
      bookNo: '002',
      invoiceSequence: '001',
      invoicePeriod: '202608',
    });
  });
});
