import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
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
