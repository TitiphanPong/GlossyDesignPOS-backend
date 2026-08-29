import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { JobType, UploadStatus } from '../uploads.enums';

export enum StorageListStatus {
  WAITING = 'waiting',
  PENDING = 'pending',
  COMPLETED = 'completed',
}

export enum StorageListSort {
  NEWEST = 'newest',
  OLDEST = 'oldest',
  CUSTOMER = 'customer',
  STATUS = 'status',
}

export enum UploadLinkStatus {
  LINKED = 'linked',
  UNLINKED = 'unlinked',
}

export class ListUploadsQueryDto {
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
  limit?: number = 20;

  /** Legacy raw-record status filter retained for API compatibility. */
  @IsOptional()
  @IsEnum(UploadStatus)
  status?: UploadStatus;

  @IsOptional()
  @IsEnum(StorageListStatus)
  storageStatus?: StorageListStatus;

  @IsOptional()
  @IsEnum(JobType)
  jobType?: JobType;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/u)
  date?: string;

  @IsOptional()
  @IsEnum(StorageListSort)
  sort?: StorageListSort = StorageListSort.NEWEST;

  @IsOptional()
  @IsEnum(UploadLinkStatus)
  linkStatus?: UploadLinkStatus;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  orderReference?: string;

  @IsOptional()
  @IsString()
  q?: string;
}
