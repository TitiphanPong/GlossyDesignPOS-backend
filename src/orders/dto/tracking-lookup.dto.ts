import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class TrackingLookupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  orderNumber!: string;

  @IsString()
  @Matches(/^\d{4}$/)
  phoneSuffix!: string;
}
