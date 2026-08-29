import { BadRequestException } from '@nestjs/common';
import {
  MAX_BACKDATE_CALENDAR_DAYS,
  normalizeBackdatedSale,
} from './order-backdate';

describe('normalizeBackdatedSale', () => {
  const now = new Date('2026-08-29T14:00:00.000Z'); // 21:00 in Bangkok

  it('accepts the full 30-Bangkok-calendar-day window and trims the reason', () => {
    const result = normalizeBackdatedSale({
      saleDate: '2026-07-30T16:30:00.000Z', // 23:30 in Bangkok
      backdatedReason: '  รายการตกหล่น  ',
      now,
    });

    expect(result).toEqual({
      saleDate: new Date('2026-07-30T16:30:00.000Z'),
      backdatedReason: 'รายการตกหล่น',
    });
    expect(MAX_BACKDATE_CALENDAR_DAYS).toBe(30);
  });

  it('rejects a sale from 31 Bangkok calendar days ago', () => {
    expect(() =>
      normalizeBackdatedSale({
        saleDate: '2026-07-29T16:30:00.000Z',
        backdatedReason: 'รายการตกหล่น',
        now,
      }),
    ).toThrow(BadRequestException);
  });

  it('uses Bangkok calendar boundaries rather than elapsed 24-hour periods', () => {
    const justAfterBangkokMidnight = new Date('2026-08-29T17:05:00.000Z'); // Aug 30 00:05

    expect(() =>
      normalizeBackdatedSale({
        saleDate: '2026-07-30T16:59:59.000Z', // Jul 30 23:59:59 Bangkok = 31 calendar days
        backdatedReason: 'รายการตกหล่น',
        now: justAfterBangkokMidnight,
      }),
    ).toThrow(BadRequestException);

    expect(
      normalizeBackdatedSale({
        saleDate: '2026-07-31T00:00:00.000Z', // Jul 31 Bangkok = 30 calendar days
        backdatedReason: 'รายการตกหล่น',
        now: justAfterBangkokMidnight,
      }).saleDate,
    ).toEqual(new Date('2026-07-31T00:00:00.000Z'));
  });

  it('rejects future dates and a missing reason', () => {
    expect(() =>
      normalizeBackdatedSale({
        saleDate: '2026-08-29T15:00:00.000Z',
        backdatedReason: 'future',
        now,
      }),
    ).toThrow('saleDate cannot be in the future.');

    expect(() =>
      normalizeBackdatedSale({
        saleDate: '2026-08-20T10:00:00.000Z',
        backdatedReason: '   ',
        now,
      }),
    ).toThrow('backdatedReason is required for a backdated order.');
  });
});
