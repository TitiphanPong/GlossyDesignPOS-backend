import { BadRequestException } from '@nestjs/common';
import {
  assertQuotationTransition,
  getEffectiveQuotationStatus,
  normalizeQuotationRangeBoundary,
  normalizeQuotationValidUntil,
  QUOTATION_TRANSITIONS,
} from './quotation.domain';
import type { QuotationStatus } from './quotation.schema';

describe('quotation domain', () => {
  it.each([
    ['DRAFT', 'SENT'],
    ['DRAFT', 'CANCELLED'],
    ['SENT', 'APPROVED'],
    ['SENT', 'REJECTED'],
    ['SENT', 'EXPIRED'],
    ['SENT', 'DRAFT'],
    ['SENT', 'CANCELLED'],
    ['APPROVED', 'CONVERTED'],
    ['APPROVED', 'DRAFT'],
    ['APPROVED', 'CANCELLED'],
    ['REJECTED', 'DRAFT'],
    ['EXPIRED', 'DRAFT'],
  ] as Array<[QuotationStatus, QuotationStatus]>)(
    'allows %s -> %s',
    (from, to) => {
      expect(() => assertQuotationTransition(from, to)).not.toThrow();
    },
  );

  it.each([
    ['CONVERTED', 'DRAFT'],
    ['CONVERTED', 'CANCELLED'],
    ['CANCELLED', 'DRAFT'],
    ['DRAFT', 'APPROVED'],
    ['REJECTED', 'APPROVED'],
  ] as Array<[QuotationStatus, QuotationStatus]>)(
    'rejects %s -> %s',
    (from, to) => {
      expect(() => assertQuotationTransition(from, to)).toThrow(
        BadRequestException,
      );
    },
  );

  it('keeps terminal states terminal', () => {
    expect(QUOTATION_TRANSITIONS.CONVERTED).toEqual([]);
    expect(QUOTATION_TRANSITIONS.CANCELLED).toEqual([]);
  });

  it('normalizes a date-only validUntil to end-of-day Asia/Bangkok', () => {
    expect(normalizeQuotationValidUntil('2026-09-01').toISOString()).toBe(
      '2026-09-01T16:59:59.999Z',
    );
  });

  it('uses Bangkok calendar boundaries for date-only list filters', () => {
    expect(
      normalizeQuotationRangeBoundary('2026-09-01', 'start').toISOString(),
    ).toBe('2026-08-31T17:00:00.000Z');
    expect(
      normalizeQuotationRangeBoundary('2026-09-01', 'end').toISOString(),
    ).toBe('2026-09-01T16:59:59.999Z');
  });

  it('returns EXPIRED effectively when a SENT quotation passes validUntil', () => {
    const validUntil = new Date('2026-09-01T16:59:59.999Z');
    expect(
      getEffectiveQuotationStatus(
        'SENT',
        validUntil,
        new Date('2026-09-01T17:00:00.000Z'),
      ),
    ).toBe('EXPIRED');
    expect(
      getEffectiveQuotationStatus(
        'SENT',
        validUntil,
        new Date('2026-09-01T16:59:59.999Z'),
      ),
    ).toBe('SENT');
  });

  it('does not auto-expire approved quotations', () => {
    expect(
      getEffectiveQuotationStatus(
        'APPROVED',
        new Date('2026-09-01T16:59:59.999Z'),
        new Date('2026-09-02T00:00:00.000Z'),
      ),
    ).toBe('APPROVED');
  });
});
