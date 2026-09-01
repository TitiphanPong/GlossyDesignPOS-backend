import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class QuickSaleV2DocumentMappingDto {
  @IsIn(['print', 'copy', 'scan'])
  workType: 'print' | 'copy' | 'scan';

  @IsIn(['A4', 'A3'])
  size: 'A4' | 'A3';

  @IsIn(['bw', 'color'])
  colorMode: 'bw' | 'color';

  @IsMongoId()
  quickProductId: string;
}

export class QuickSaleV2DocumentDefaultsDto {
  @IsIn(['print', 'copy', 'scan'])
  workType: 'print' | 'copy' | 'scan';

  @IsIn(['A4', 'A3'])
  size: 'A4' | 'A3';

  @IsIn(['bw', 'color'])
  colorMode: 'bw' | 'color';

  @IsInt()
  @Min(1)
  @Max(999)
  quantity: number;
}

export class UpdateQuickSaleV2DraftDto {
  @ValidateNested()
  @Type(() => QuickSaleV2DocumentDefaultsDto)
  defaults: QuickSaleV2DocumentDefaultsDto;

  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => QuickSaleV2DocumentMappingDto)
  mappings: QuickSaleV2DocumentMappingDto[];
}
