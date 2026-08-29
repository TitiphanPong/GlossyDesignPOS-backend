import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class LinkUploadOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  uploadIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  orderReference?: string | null;
}
