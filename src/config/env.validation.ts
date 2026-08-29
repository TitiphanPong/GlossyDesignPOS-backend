import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

class EnvironmentVariables {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT?: number;

  @IsString()
  @IsNotEmpty()
  FRONTEND_ORIGIN: string;

  @IsString()
  @IsNotEmpty()
  AWS_REGION: string;

  @IsString()
  @IsNotEmpty()
  AWS_ACCESS_KEY_ID: string;

  @IsString()
  @IsNotEmpty()
  AWS_SECRET_ACCESS_KEY: string;

  @IsString()
  @IsNotEmpty()
  AWS_S3_BUCKET_PRIVATE: string;

  @IsOptional()
  @IsString()
  AWS_S3_KMS_KEY_ID?: string;

  @IsString()
  @IsNotEmpty()
  MONGODB_URI: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ADMIN_LOGIN_USERNAME?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  ADMIN_LOGIN_PASSWORD?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  AGENT_LOGIN_USERNAME?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  AGENT_LOGIN_PASSWORD?: string;

  @IsOptional()
  @IsIn(['staff', 'manager', 'admin'])
  AGENT_LOGIN_ROLE?: string;

  @IsOptional()
  @IsIn(['development', 'test', 'production'])
  NODE_ENV?: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(`Config validation error: ${errors.toString()}`);
  }

  if (
    Boolean(validatedConfig.ADMIN_LOGIN_USERNAME) !==
    Boolean(validatedConfig.ADMIN_LOGIN_PASSWORD)
  ) {
    throw new Error(
      'Config validation error: ADMIN_LOGIN_USERNAME and ADMIN_LOGIN_PASSWORD must be provided together',
    );
  }

  if (
    Boolean(validatedConfig.AGENT_LOGIN_USERNAME) !==
    Boolean(validatedConfig.AGENT_LOGIN_PASSWORD)
  ) {
    throw new Error(
      'Config validation error: AGENT_LOGIN_USERNAME and AGENT_LOGIN_PASSWORD must be provided together',
    );
  }

  return validatedConfig;
}
