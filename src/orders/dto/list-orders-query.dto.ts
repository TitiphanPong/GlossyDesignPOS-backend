import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  PAYMENT_METHODS,
  OrderStatus,
  OrderType,
  PaymentMethod,
} from '../orders.schema';

export class ListOrdersQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsIn(ORDER_TYPES)
  orderType?: OrderType;

  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @IsOptional()
  @IsDateString()
  createdTo?: string;

  @IsOptional()
  @IsDateString()
  saleFrom?: string;

  @IsOptional()
  @IsDateString()
  saleTo?: string;

  @IsOptional()
  @IsIn(['all', 'normal', 'backdated'])
  entryMode?: 'all' | 'normal' | 'backdated';

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  saleMonth?: string;

  @IsOptional()
  @IsIn(['newest', 'oldest', 'amount_desc', 'amount_asc'])
  sort?: 'newest' | 'oldest' | 'amount_desc' | 'amount_asc';
}

export class ExportOrdersQueryDto extends ListOrdersQueryDto {
  @IsIn(['xlsx', 'pdf'])
  format!: 'xlsx' | 'pdf';
}
