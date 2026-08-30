import type { ProductionJobStage } from './schemas/production-job.schema';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const COMPLETE_PRODUCTION_JOB_STAGES = [
  'ready',
  'delivered',
] as const satisfies readonly ProductionJobStage[];

export function bangkokProductionDayBounds(now: Date) {
  const bangkokNow = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  const utcDay = Date.UTC(
    bangkokNow.getUTCFullYear(),
    bangkokNow.getUTCMonth(),
    bangkokNow.getUTCDate(),
  );
  const start = new Date(utcDay - BANGKOK_OFFSET_MS);
  return {
    start,
    end: new Date(start.getTime() + DAY_MS),
  };
}

export function incompleteProductionJobMatch() {
  return { stage: { $nin: [...COMPLETE_PRODUCTION_JOB_STAGES] } };
}
