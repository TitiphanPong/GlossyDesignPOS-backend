import { IsString, MaxLength, MinLength } from 'class-validator';

export class LineSessionDto {
  @IsString()
  @MinLength(20)
  @MaxLength(4096)
  idToken!: string;
}
