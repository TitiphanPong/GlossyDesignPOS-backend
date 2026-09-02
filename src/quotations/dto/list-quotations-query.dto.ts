import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { QUOTATION_STATUSES, type QuotationStatus } from '../quotation.schema';

export const QUOTATION_SORTS = [
  'newest',
  'oldest',
  'validUntilAsc',
  'validUntilDesc',
  'amountDesc',
  'amountAsc',
] as const;
export type QuotationSort = (typeof QUOTATION_SORTS)[number];

export class ListQuotationsQueryDto {
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
  search?: string;

  @IsOptional()
  @IsIn(QUOTATION_STATUSES)
  status?: QuotationStatus;

  @IsOptional()
  @IsMongoId()
  customerId?: string;

  @IsOptional()
  @IsDateString()
  issuedFrom?: string;

  @IsOptional()
  @IsDateString()
  issuedTo?: string;

  @IsOptional()
  @IsDateString()
  validFrom?: string;

  @IsOptional()
  @IsDateString()
  validTo?: string;

  @IsOptional()
  @IsIn(QUOTATION_SORTS)
  sort?: QuotationSort = 'newest';
}
