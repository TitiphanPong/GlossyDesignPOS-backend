export const PUBLIC_TRACKING_MILESTONES = [
  'received',
  'in_progress',
  'ready',
  'completed',
  'cancelled',
] as const;

export type PublicTrackingMilestone =
  (typeof PUBLIC_TRACKING_MILESTONES)[number];

export class PublicTrackingMilestoneDto {
  milestone!: PublicTrackingMilestone;
  reachedAt?: Date;
}

export class PublicTrackingResponseDto {
  orderNumber!: string;
  currentMilestone!: PublicTrackingMilestone;
  milestones!: PublicTrackingMilestoneDto[];
  updatedAt?: Date;
}
