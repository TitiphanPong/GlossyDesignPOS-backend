import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PRODUCTION_JOB_PRIORITIES,
  PRODUCTION_JOB_STAGES,
  ProductionJobPriority,
  ProductionJobStage,
} from '../schemas/production-job.schema';

export class CreateProductionJobDto {
  @IsString()
  @IsNotEmpty()
  orderId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  workSummary!: string;

  @IsDateString()
  dueAt!: string;

  @IsOptional()
  @IsIn(PRODUCTION_JOB_PRIORITIES)
  priority?: ProductionJobPriority;

  @IsOptional()
  @IsString()
  assigneeUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  linkedUploadIds?: string[];
}

export class UpdateProductionJobDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(240)
  workSummary?: string;

  @IsOptional()
  @IsDateString()
  dueAt?: string;

  @IsOptional()
  @IsIn(PRODUCTION_JOB_PRIORITIES)
  priority?: ProductionJobPriority;

  @IsOptional()
  @IsString()
  assigneeUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  linkedUploadIds?: string[];
}

export class UpdateProductionJobStageDto {
  @IsIn(PRODUCTION_JOB_STAGES)
  stage!: ProductionJobStage;
}

export class ListProductionJobsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 25;

  @IsOptional()
  @IsIn(PRODUCTION_JOB_STAGES)
  stage?: ProductionJobStage;

  @IsOptional()
  @IsIn(PRODUCTION_JOB_PRIORITIES)
  priority?: ProductionJobPriority;

  @IsOptional()
  @IsString()
  assigneeUserId?: string;

  @IsOptional()
  @IsIn(['all', 'today', 'overdue'])
  due?: 'all' | 'today' | 'overdue';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
