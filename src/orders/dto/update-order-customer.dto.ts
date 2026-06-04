import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ORDER_STATUSES, OrderStatus } from '../orders.schema';

export class UpdateOrderCustomerDto {
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  statusNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerName?: string;

  // Accepted for frontend compatibility, but intentionally ignored by the service.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  customerTaxId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  customerAddress?: string;
}
