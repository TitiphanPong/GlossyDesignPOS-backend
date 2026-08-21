import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

export class DashboardSummaryQueryDto {
  @IsOptional()
  @IsIn(['today', 'month'])
  period?: 'today' | 'month' = 'today';

  @ValidateIf((query: DashboardSummaryQueryDto) => query.period === 'month')
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;
}
