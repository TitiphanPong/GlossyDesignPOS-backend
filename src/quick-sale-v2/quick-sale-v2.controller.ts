import { Body, Controller, Get, Put, Post, Request } from '@nestjs/common';
import { Roles } from '../auth/auth.decorators';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { UpdateQuickSaleV2DraftDto } from './quick-sale-v2.dto';
import { QuickSaleV2Service } from './quick-sale-v2.service';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('quick-sale-v2/config')
export class QuickSaleV2Controller {
  constructor(
    private readonly quickSaleV2Service: QuickSaleV2Service,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  getPublished() {
    return this.quickSaleV2Service.getPublished();
  }

  @Get('draft')
  @Roles('manager', 'admin')
  getDraft() {
    return this.quickSaleV2Service.getDraft();
  }

  @Put('draft')
  @Roles('manager', 'admin')
  async updateDraft(
    @Body() dto: UpdateQuickSaleV2DraftDto,
    @Request() request: AuthRequest,
  ) {
    const config = await this.quickSaleV2Service.updateDraft(dto.mappings);
    await this.auditService.record(
      request.user ?? null,
      'quick-sale-v2.draft.update',
      {
        type: 'quick-sale-v2-config',
        id: 'default',
      },
    );
    return config;
  }

  @Post('publish')
  @Roles('manager', 'admin')
  async publish(@Request() request: AuthRequest) {
    const config = await this.quickSaleV2Service.publish();
    await this.auditService.record(
      request.user ?? null,
      'quick-sale-v2.publish',
      {
        type: 'quick-sale-v2-config',
        id: `default:v${config.version}`,
      },
    );
    return config;
  }
}
