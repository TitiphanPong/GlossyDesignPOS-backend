import { IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateOrderCustomerDto {
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
