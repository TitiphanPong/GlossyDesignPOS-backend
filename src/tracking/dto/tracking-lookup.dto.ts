import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class TrackingLookupDto {
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9-]+$/, {
    message: 'orderNumber contains invalid characters',
  })
  orderNumber!: string;

  @IsString()
  @Matches(/^\d{4}$/, { message: 'phoneSuffix must be exactly 4 digits' })
  phoneSuffix!: string;
}

export type PublicTrackingResponseDto = {
  orderNumber: string;
  status: string;
  createdAt?: Date;
  updatedAt?: Date;
};
