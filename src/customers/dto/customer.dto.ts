import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const optionalTrim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

const optionalBoolean = ({ value }: { value: unknown }): unknown => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

export class CreateCustomerDto {
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsEmail()
  @MaxLength(160)
  email?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(13)
  taxId?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(160)
  companyName?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(80)
  branchType?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(20)
  branchNo?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(120)
  subDistrict?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(120)
  province?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(10)
  postalCode?: string;

  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(500)
  shippingAddress?: string;
}

export class UpdateCustomerDto extends CreateCustomerDto {
  @IsOptional()
  declare displayName: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListCustomersQueryDto {
  @IsOptional()
  @Transform(optionalTrim)
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(optionalBoolean)
  @IsBoolean()
  active?: boolean;
}
