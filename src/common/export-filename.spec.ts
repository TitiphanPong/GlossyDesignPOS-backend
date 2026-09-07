import {
  buildDateRangeScope,
  buildExportFilename,
  formatBangkokDateScope,
  normalizeMonthScope,
  resolveOrderExportDateScope,
} from './export-filename';

describe('export filename helpers', () => {
  it('builds the shared glossy kebab-case filename standard', () => {
    expect(
      buildExportFilename({
        artifact: 'tax-invoices',
        variant: 'summary',
        scope: '2026-09',
        extension: '.pdf',
      }),
    ).toBe('glossy-tax-invoices-summary-2026-09.pdf');
  });

  it('normalizes compact and dashed month scopes', () => {
    expect(normalizeMonthScope('202609')).toBe('2026-09');
    expect(normalizeMonthScope('2026-09')).toBe('2026-09');
  });

  it('formats dates in the Bangkok business timezone', () => {
    expect(formatBangkokDateScope('2026-09-06T18:30:00.000Z')).toBe(
      '2026-09-07',
    );
  });

  it('builds deterministic single-day and multi-day scopes', () => {
    expect(
      buildDateRangeScope(
        '2026-09-01T00:00:00.000+07:00',
        '2026-09-01T23:59:59.999+07:00',
      ),
    ).toBe('2026-09-01');
    expect(
      buildDateRangeScope(
        '2026-09-01T00:00:00.000+07:00',
        '2026-09-07T23:59:59.999+07:00',
      ),
    ).toBe('2026-09-01_to_2026-09-07');
  });

  it('resolves order export scope from month, today, range, then all', () => {
    expect(resolveOrderExportDateScope({ saleMonth: '2026-09' })).toBe(
      '2026-09',
    );
    expect(
      resolveOrderExportDateScope(
        { period: 'today' },
        new Date('2026-09-06T18:30:00.000Z'),
      ),
    ).toBe('2026-09-07');
    expect(
      resolveOrderExportDateScope({
        saleFrom: '2026-09-01T00:00:00.000+07:00',
        saleTo: '2026-09-07T23:59:59.999+07:00',
      }),
    ).toBe('2026-09-01_to_2026-09-07');
    expect(resolveOrderExportDateScope({})).toBe('all');
  });
});
