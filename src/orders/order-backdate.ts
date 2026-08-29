import { BadRequestException } from '@nestjs/common';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
export const MAX_BACKDATE_CALENDAR_DAYS = 30;

function bangkokCalendarDayNumber(value: Date): number {
  const shifted = new Date(value.getTime() + BANGKOK_OFFSET_MS);
  return Math.floor(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) / DAY_MS,
  );
}

export function normalizeBackdatedSale(input: {
  saleDate?: string;
  backdatedReason?: string;
  now?: Date;
}): { saleDate: Date; backdatedReason: string } {
  const now = input.now ?? new Date();
  const saleDate = new Date(input.saleDate ?? '');

  if (!input.saleDate || Number.isNaN(saleDate.getTime())) {
    throw new BadRequestException(
      'saleDate is required for a backdated order.',
    );
  }
  if (saleDate.getTime() > now.getTime()) {
    throw new BadRequestException('saleDate cannot be in the future.');
  }

  const calendarDaysAgo =
    bangkokCalendarDayNumber(now) - bangkokCalendarDayNumber(saleDate);
  if (calendarDaysAgo < 0 || calendarDaysAgo > MAX_BACKDATE_CALENDAR_DAYS) {
    throw new BadRequestException(
      `Backdated orders may be at most ${MAX_BACKDATE_CALENDAR_DAYS} Bangkok calendar days old.`,
    );
  }

  const backdatedReason = input.backdatedReason?.trim() ?? '';
  if (!backdatedReason) {
    throw new BadRequestException(
      'backdatedReason is required for a backdated order.',
    );
  }

  return { saleDate, backdatedReason };
}
