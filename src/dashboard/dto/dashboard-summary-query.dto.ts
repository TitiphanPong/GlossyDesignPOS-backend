import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  ValidateIf,
} from 'class-validator';

export class DashboardSummaryQueryDto {
  @IsOptional()
  @IsIn(['today', 'last7', 'month', 'custom'])
  period?: 'today' | 'last7' | 'month' | 'custom' = 'today';

  @ValidateIf((query: DashboardSummaryQueryDto) => query.period === 'month')
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
  month?: string;

  @ValidateIf((query: DashboardSummaryQueryDto) => query.period === 'custom')
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  startDate?: string;

  @ValidateIf((query: DashboardSummaryQueryDto) => query.period === 'custom')
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/)
  endDate?: string;
}
