import { BadRequestException } from '@nestjs/common';
import type { QuotationStatus } from './quotation.schema';

export const QUOTATION_TRANSITIONS: Readonly<
  Record<QuotationStatus, readonly QuotationStatus[]>
> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['APPROVED', 'REJECTED', 'EXPIRED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['CONVERTED', 'DRAFT', 'CANCELLED'],
  REJECTED: ['DRAFT'],
  EXPIRED: ['DRAFT'],
  CANCELLED: [],
  CONVERTED: [],
};

export function assertQuotationTransition(
  from: QuotationStatus,
  to: QuotationStatus,
): void {
  if (!QUOTATION_TRANSITIONS[from].includes(to)) {
    throw new BadRequestException(
      `Quotation transition ${from} -> ${to} is not allowed.`,
    );
  }
}

export function normalizeQuotationValidUntil(value: string | Date): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new BadRequestException('validUntil must be a valid date.');
    }
    return value;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    // Asia/Bangkok has no DST. Store the inclusive end of that Bangkok day.
    const parsed = new Date(`${value}T16:59:59.999Z`);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('validUntil must be a valid date.');
    }
    return parsed;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('validUntil must be a valid date.');
  }
  return parsed;
}

export function normalizeQuotationRangeBoundary(
  value: string,
  boundary: 'start' | 'end',
): Date {
  const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(value)
    ? new Date(
        `${value}${boundary === 'start' ? 'T00:00:00.000+07:00' : 'T23:59:59.999+07:00'}`,
      )
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      'Quotation date filter must be a valid date.',
    );
  }
  return parsed;
}

export function getEffectiveQuotationStatus(
  storedStatus: QuotationStatus,
  validUntil: Date | undefined,
  now: Date = new Date(),
): QuotationStatus {
  if (
    storedStatus === 'SENT' &&
    validUntil &&
    validUntil.getTime() < now.getTime()
  ) {
    return 'EXPIRED';
  }
  return storedStatus;
}
