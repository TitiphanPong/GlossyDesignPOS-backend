import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsMongoId,
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

export class UpdateQuickSaleV2DraftDto {
  @IsArray()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => QuickSaleV2DocumentMappingDto)
  mappings: QuickSaleV2DocumentMappingDto[];
}
