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

  @IsOptional()
  @IsString()
  @MaxLength(255)
  companyName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phoneNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customerEmail?: string;

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

  @IsOptional()
  @IsString()
  @MaxLength(120)
  branch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerBranch?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  branchType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  branchNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  subDistrict?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  province?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  shippingAddress?: string;
}
