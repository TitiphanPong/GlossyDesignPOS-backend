import type { OrderStatus } from '../orders.schema';

export class PublicTrackingResponseDto {
  orderNumber!: string;
  status!: OrderStatus;
  createdAt?: Date;
  updatedAt?: Date;
}
