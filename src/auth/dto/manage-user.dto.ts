import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { USER_ROLES, UserRole } from '../auth.constants';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  username: string;

  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password: string;

  @IsEnum(USER_ROLES)
  role: UserRole;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(200)
  password?: string;

  @IsOptional()
  @IsEnum(USER_ROLES)
  role?: UserRole;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
