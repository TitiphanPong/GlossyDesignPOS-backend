import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import { AuditService } from '../auth/audit.service';
import { Roles } from '../auth/auth.decorators';
import { AuthenticatedUser } from '../auth/auth.types';
import {
  CreateStockItemDto,
  ListStockItemsQueryDto,
  RecordStockMovementDto,
  UpdateStockItemDto,
} from './dto/inventory.dto';
import { InventoryService } from './inventory.service';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly auditService: AuditService,
  ) {}

  @Get('items')
  findAll(@Query() query: ListStockItemsQueryDto) {
    return this.inventoryService.listStockItems(
      query.q,
      query.includeInactive === 'true',
    );
  }

  @Get('items/:id')
  findOne(@Param('id') id: string) {
    return this.inventoryService.getStockItem(id);
  }

  @Post('items')
  @Roles('manager', 'admin')
  async create(
    @Body() dto: CreateStockItemDto,
    @Request() request: AuthRequest,
  ) {
    const item = await this.inventoryService.createStockItem(dto);
    await this.auditService.record(
      request.user ?? null,
      'inventory.item.create',
      {
        type: 'stock-item',
        id: String(item._id),
      },
    );
    return item;
  }

  @Patch('items/:id')
  @Roles('manager', 'admin')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateStockItemDto,
    @Request() request: AuthRequest,
  ) {
    const item = await this.inventoryService.updateStockItem(id, dto);
    await this.auditService.record(
      request.user ?? null,
      'inventory.item.update',
      {
        type: 'stock-item',
        id: String(item._id),
      },
    );
    return item;
  }

  @Post('items/:id/movements')
  async move(
    @Param('id') id: string,
    @Body() dto: RecordStockMovementDto,
    @Request() request: AuthRequest,
  ) {
    const user = request.user;
    if (!user) throw new Error('Authenticated user context is required.');
    const isAdjustment =
      dto.type === 'adjustment_in' || dto.type === 'adjustment_out';
    if (isAdjustment && user.role !== 'manager' && user.role !== 'admin') {
      // Keep manual corrections privileged while normal receive/issue remains available to authenticated staff.
      throw new ForbiddenException(
        'Manual stock adjustment requires manager or admin role.',
      );
    }
    const movement = await this.inventoryService.recordMovement(
      id,
      {
        type: dto.type,
        quantity: dto.quantity,
        reason: dto.reason,
        idempotencyKey: dto.idempotencyKey,
        businessReference:
          dto.referenceType && dto.referenceId
            ? { type: dto.referenceType, id: dto.referenceId }
            : undefined,
      },
      user,
    );
    await this.auditService.record(user, 'inventory.movement.create', {
      type: 'stock-movement',
      id: String(movement._id),
    });
    return movement;
  }
}
