import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { AuditService } from '../auth/audit.service';
import type { AuthenticatedUser } from '../auth/auth.types';
import {
  ApproveQuotationDto,
  CancelQuotationDto,
  ConvertQuotationDto,
  CreateQuotationDto,
  RejectQuotationDto,
  UpdateQuotationDto,
  VersionedQuotationCommandDto,
} from './dto/quotation.dto';
import { ListQuotationsQueryDto } from './dto/list-quotations-query.dto';
import { QuotationsService } from './quotations.service';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('quotations')
export class QuotationsController {
  constructor(
    private readonly quotationsService: QuotationsService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  async create(
    @Body() dto: CreateQuotationDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request);
    const quotation = await this.quotationsService.create(dto, actor);
    await this.auditService.record(actor, 'quotation.create', {
      type: 'quotation',
      id: quotation._id,
    });
    return quotation;
  }

  @Get()
  list(@Query() query: ListQuotationsQueryDto) {
    return this.quotationsService.list(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.quotationsService.findById(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateQuotationDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request);
    const quotation = await this.quotationsService.update(id, dto, actor);
    await this.auditService.record(
      actor,
      'quotation.update',
      {
        type: 'quotation',
        id,
      },
      { revision: quotation.revision },
    );
    return quotation;
  }

  @Post(':id/send')
  async send(
    @Param('id') id: string,
    @Body() dto: VersionedQuotationCommandDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request);
    const quotation = await this.quotationsService.send(id, dto, actor);
    await this.auditService.record(
      actor,
      'quotation.send',
      {
        type: 'quotation',
        id,
      },
      {
        quotationNumber: quotation.quotationNumber ?? '',
        revision: quotation.revision,
      },
    );
    return quotation;
  }

  @Post(':id/approve')
  async approve(
    @Param('id') id: string,
    @Body() dto: ApproveQuotationDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request);
    const quotation = await this.quotationsService.approve(id, dto, actor);
    await this.auditService.record(
      actor,
      'quotation.approve',
      {
        type: 'quotation',
        id,
      },
      { revision: quotation.revision },
    );
    return quotation;
  }

  @Post(':id/reject')
  async reject(
    @Param('id') id: string,
    @Body() dto: RejectQuotationDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request);
    const quotation = await this.quotationsService.reject(id, dto, actor);
    await this.auditService.record(
      actor,
      'quotation.reject',
      {
        type: 'quotation',
        id,
      },
      { revision: quotation.revision, reason: dto.reason },
    );
    return quotation;
  }

  @Post(':id/revise')
  async revise(
    @Param('id') id: string,
    @Body() dto: VersionedQuotationCommandDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request);
    const quotation = await this.quotationsService.revise(id, dto, actor);
    await this.auditService.record(
      actor,
      'quotation.revise',
      {
        type: 'quotation',
        id,
      },
      { revision: quotation.revision },
    );
    return quotation;
  }

  @Post(':id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelQuotationDto,
    @Request() request: AuthRequest,
  ) {
    const actor = this.requireActor(request);
    const quotation = await this.quotationsService.cancel(id, dto, actor);
    await this.auditService.record(
      actor,
      'quotation.cancel',
      {
        type: 'quotation',
        id,
      },
      { revision: quotation.revision, reason: dto.reason },
    );
    return quotation;
  }

  @Post(':id/convert-to-order')
  async convertToOrder(
    @Param('id') id: string,
    @Body() dto: ConvertQuotationDto,
    @Request() request: AuthRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const actor = this.requireActor(request);
    const result = await this.quotationsService.convertToOrder(
      id,
      dto,
      actor,
      idempotencyKey,
    );
    await this.auditService.record(
      actor,
      'quotation.convert_to_order',
      {
        type: 'quotation',
        id,
      },
      {
        quotationNumber: result.quotation.quotationNumber ?? '',
        revision: result.quotation.revision,
        orderId: result.order._id,
        replayed: result.replayed,
      },
    );
    return result;
  }

  private requireActor(request: AuthRequest): AuthenticatedUser {
    if (!request.user) {
      throw new Error('Authenticated user context is required.');
    }
    return request.user;
  }
}
