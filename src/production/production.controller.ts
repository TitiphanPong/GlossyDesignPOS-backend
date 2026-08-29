import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  CreateProductionJobDto,
  ListProductionJobsQueryDto,
  UpdateProductionJobDto,
  UpdateProductionJobStageDto,
} from './dto/production-job.dto';
import { ProductionService } from './production.service';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('production/jobs')
export class ProductionController {
  constructor(
    private readonly productionService: ProductionService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  list(@Query() query: ListProductionJobsQueryDto) {
    return this.productionService.listJobs(query);
  }

  @Get('order/:orderId')
  listForOrder(@Param('orderId') orderId: string) {
    return this.productionService.listOrderJobs(orderId);
  }

  @Get('assignees')
  listAssignees() {
    return this.productionService.listAssignees();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.productionService.getJob(id);
  }

  @Post()
  async create(
    @Body() dto: CreateProductionJobDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request.user);
    const created = await this.productionService.createJob(dto, actor);
    await this.auditService.record(actor, 'production.job.create', {
      type: 'production-job',
      id: created.id,
    });
    return created;
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProductionJobDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request.user);
    const updated = await this.productionService.updateJob(id, dto);
    await this.auditService.record(actor, 'production.job.update', {
      type: 'production-job',
      id,
    });
    return updated;
  }

  @Patch(':id/stage')
  async updateStage(
    @Param('id') id: string,
    @Body() dto: UpdateProductionJobStageDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request.user);
    const updated = await this.productionService.updateStage(
      id,
      dto.stage,
      actor,
    );
    await this.auditService.record(
      actor,
      'production.job.stage.update',
      { type: 'production-job', id },
      { stage: dto.stage },
    );
    return updated;
  }

  private requireActor(user?: AuthenticatedUser) {
    if (!user) throw new Error('Authenticated user context is required.');
    return user;
  }
}
