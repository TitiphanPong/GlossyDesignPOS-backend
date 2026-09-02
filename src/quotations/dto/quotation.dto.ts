import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class QuotationPriceOverrideDto {
  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0.01)
  unitPrice!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  reason!: string;
}

export class QuotationDiscountDto {
  @IsIn(['amount', 'percent'])
  type!: 'amount' | 'percent';

  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(0)
  @Max(100_000_000)
  value!: number;
}

export class QuotationCustomerSnapshotDto {
  @IsOptional() @IsString() @MaxLength(160) customerName?: string;
  @IsOptional() @IsString() @MaxLength(30) phoneNumber?: string;
  @IsOptional() @IsString() @MaxLength(160) email?: string;
  @IsOptional() @IsString() @MaxLength(30) taxId?: string;
  @IsOptional() @IsString() @MaxLength(80) branchType?: string;
  @IsOptional() @IsString() @MaxLength(20) branchNo?: string;
  @IsOptional() @IsString() @MaxLength(500) address?: string;
  @IsOptional() @IsString() @MaxLength(120) subDistrict?: string;
  @IsOptional() @IsString() @MaxLength(120) district?: string;
  @IsOptional() @IsString() @MaxLength(120) province?: string;
  @IsOptional() @IsString() @MaxLength(10) postalCode?: string;
}

export class QuotationSizeFlexDto {
  @IsString() height!: string;
  @IsString() width!: string;
}

export class QuotationItemRequestDto {
  @IsOptional() @IsString() @MaxLength(120) productId?: string;
  @IsOptional() @IsString() @MaxLength(120) variantId?: string;
  @IsOptional() @IsString() @MaxLength(120) quickProductId?: string;
  @IsOptional() @IsString() @MaxLength(120) productCode?: string;
  @IsOptional() @IsString() @MaxLength(120) typeCode?: string;
  @IsOptional() @IsString() @MaxLength(255) variantName?: string;
  @IsOptional() @IsString() @MaxLength(255) customName?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional() @IsString() @MaxLength(40) unit?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuotationPriceOverrideDto)
  priceOverride?: QuotationPriceOverrideDto;

  @IsOptional() @IsString() material?: string;
  @IsOptional() @IsString() colorMode?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsString() typePremium?: string;
  @IsOptional() @IsString() shape?: string;
  @IsOptional() @IsString() size?: string;
  @IsOptional() @IsString() sides?: string;
  @IsOptional() @IsString() productNote?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) setCount?: number;
  @IsOptional() @IsString() inkjetType?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @ValidateNested({ each: true })
  @Type(() => QuotationSizeFlexDto)
  sizeFlex?: QuotationSizeFlexDto[];
  @IsOptional() @IsString() stickerPVCType?: string;
  @IsOptional() @IsString() plotPlanType?: string;
}

export class CreateQuotationDto {
  @IsOptional() @IsMongoId() customerId?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => QuotationCustomerSnapshotDto)
  customerSnapshot?: QuotationCustomerSnapshotDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @ValidateNested({ each: true })
  @Type(() => QuotationItemRequestDto)
  items?: QuotationItemRequestDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => QuotationDiscountDto)
  discount?: QuotationDiscountDto;

  @IsOptional() @IsBoolean() taxInvoiceRequested?: boolean;
  @IsOptional() @IsDateString() validUntil?: string;
  @IsOptional() @IsString() @MaxLength(300) subject?: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @IsString() @MaxLength(10000) termsAndConditions?: string;
  @IsOptional() @IsString() @MaxLength(5000) paymentTerms?: string;
  @IsOptional() @IsString() @MaxLength(5000) deliveryTerms?: string;
  @IsOptional() @IsString() @MaxLength(5000) internalNote?: string;
}

export class UpdateQuotationDto extends CreateQuotationDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;
}

export class VersionedQuotationCommandDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  @IsOptional()
  @Transform(({ value }) => {
    const rawValue: unknown = value;
    return typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  })
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ApproveQuotationDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version!: number;

  @Transform(({ value }) => {
    const rawValue: unknown = value;
    return typeof rawValue === 'string' ? rawValue.trim() : rawValue;
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

export class RejectQuotationDto extends ApproveQuotationDto {}

export class CancelQuotationDto extends ApproveQuotationDto {}

export class ConvertQuotationDto extends VersionedQuotationCommandDto {
  @IsOptional() @IsBoolean() confirmQuotedPrice?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  priceConflictReason?: string;
}
