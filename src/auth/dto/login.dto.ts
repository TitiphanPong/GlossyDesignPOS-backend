import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  username: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  password: string;
}
