import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum JobType {
  DOCUMENT_PRINTING = 'Document Printing',
  PHOTOCOPY = 'Photocopy',
  STICKER = 'Sticker',
  BUSINESS_CARD = 'Business Card',
  POSTER = 'Poster',
  VINYL_BANNER = 'Vinyl Banner',
  PACKAGING = 'Packaging',
  OTHER = 'Other',
}

export class CreateUploadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  customerName: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+$/, { message: 'phone must contain digits only' })
  @MinLength(9)
  @MaxLength(20)
  phone: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsEnum(JobType)
  jobType: JobType;
}
