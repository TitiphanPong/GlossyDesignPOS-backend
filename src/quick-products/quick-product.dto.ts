import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateQuickProductDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name!: string;
  @IsString() @IsNotEmpty() @MaxLength(80) code!: string;
  @IsOptional() @IsString() @MaxLength(80) typeCode?: string;
  @IsString() @IsNotEmpty() @MaxLength(120) category!: string;
  @Type(() => Number) @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsString() @MaxLength(40) unitLabel?: string;
  @IsOptional() @IsString() @MaxLength(8) emoji?: string;
  @IsOptional() @IsString() @MaxLength(30) tint?: string;
  @IsOptional() @IsBoolean() isHotMenu?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quickSaleSortOrder?: number;
}

export class UpdateQuickProductDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) code?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) typeCode?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) category?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) price?: number;
  @IsOptional() @IsString() @MaxLength(40) unitLabel?: string;
  @IsOptional() @IsString() @MaxLength(8) emoji?: string;
  @IsOptional() @IsString() @MaxLength(30) tint?: string;
  @IsOptional() @IsBoolean() isHotMenu?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  quickSaleSortOrder?: number;
}

export class ReorderQuickProductItemDto {
  @IsMongoId() id!: string;
  @Type(() => Number) @IsNumber() @Min(0) quickSaleSortOrder!: number;
}

export class ReorderQuickProductsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReorderQuickProductItemDto)
  items!: ReorderQuickProductItemDto[];
}
