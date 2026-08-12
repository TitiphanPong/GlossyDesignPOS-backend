import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { QuickProduct } from './quick-product.schema';
import { QuickProductService } from './quick-product.service';
import {
  CreateQuickProductDto,
  UpdateQuickProductDto,
} from './quick-product.dto';
import { Roles } from '../auth/auth.decorators';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('quick-products')
export class QuickProductController {
  constructor(
    private readonly quickProductService: QuickProductService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  findAll(
    @Query('includeInactive') includeInactive?: string,
  ): Promise<QuickProduct[]> {
    return this.quickProductService.findAll(includeInactive === 'true');
  }

  @Post()
  @Roles('manager', 'admin')
  async create(
    @Body() dto: CreateQuickProductDto,
    @Request() request: AuthRequest,
  ) {
    const product = await this.quickProductService.create(dto);
    await this.auditService.record(
      request.user ?? null,
      'quick-product.create',
      { type: 'quick-product', id: product.code },
    );
    return product;
  }

  @Patch(':id')
  @Roles('manager', 'admin')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateQuickProductDto,
    @Request() request: AuthRequest,
  ) {
    const product = await this.quickProductService.update(id, dto);
    await this.auditService.record(
      request.user ?? null,
      'quick-product.update',
      { type: 'quick-product', id: product.code },
    );
    return product;
  }

  @Delete(':id')
  @Roles('admin')
  async remove(@Param('id') id: string, @Request() request: AuthRequest) {
    const product = await this.quickProductService.remove(id);
    await this.auditService.record(
      request.user ?? null,
      'quick-product.delete',
      { type: 'quick-product', id: product.code },
    );
    return product;
  }
}
