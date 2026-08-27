// src/orders/orders.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Sse,
  Request,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { OrdersService } from './orders.service';
import { CustomerSseMessage, OrdersSseService } from './orders.sse.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { UpdateOrderCustomerDto } from './dto/update-order-customer.dto';
import {
  AddPaymentDto,
  CreateOrderDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { AuthService } from '../auth/auth.service';
import { DeleteOrderDto } from './dto/delete-order.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { ExportOrdersQueryDto } from './dto/list-orders-query.dto';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly ordersSse: OrdersSseService,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
  ) {}

  @Post()
  async create(
    @Body() order: CreateOrderDto,
    @Request() request: AuthRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    const created = await this.ordersService.create(
      order,
      idempotencyKey,
      request.user?.role,
    );
    await this.auditService.record(request.user ?? null, 'order.create', {
      type: 'order',
      id: created._id,
    });
    return created;
  }

  @Get()
  async findAll(@Query() query: ListOrdersQueryDto) {
    const definedQuery = Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined),
    ) as ListOrdersQueryDto;
    return this.ordersService.findAll(definedQuery);
  }

  @Get('summary')
  async getSummary() {
    return this.ordersService.getSummary();
  }

  @Get('export')
  async exportOrders(
    @Query() query: ExportOrdersQueryDto,
    @Request() request: AuthRequest,
    @Res() response: Response,
  ): Promise<void> {
    const exported = await this.ordersService.exportOrders(query);
    await this.auditService.record(
      request.user ?? null,
      'order.report.export',
      { type: 'order_report', id: query.saleMonth ?? 'all' },
      {
        format: query.format,
        count: exported.count,
        saleMonth: query.saleMonth ?? 'all',
      },
    );
    response.setHeader('Content-Type', exported.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${exported.filename}"`,
    );
    response.setHeader('Content-Length', String(exported.buffer.length));
    response.end(exported.buffer);
  }

  // ✅ SSE stream สำหรับหน้า Customer
  @Sse('events')
  events(): Observable<CustomerSseMessage> {
    return this.ordersSse.asObservable();
  }

  // (ตัวเลือก) Endpoint ดึงออเดอร์ล่าสุดที่เป็น active (pending/paid)
  @Get('latest')
  async latestActive() {
    return this.ordersService.findLatestActive();
  }

  // (ตัวเลือก) Endpoint เปลี่ยนสถานะ แบบเรียบง่าย
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: UpdateOrderStatusDto,
    @Request() request: AuthRequest,
  ) {
    const updated = await this.ordersService.updateStatus(
      id,
      body.status,
      body.statusNote,
    );
    await this.auditService.record(
      request.user ?? null,
      'order.status.update',
      { type: 'order', id },
      { status: body.status },
    );
    return updated;
  }

  @Get('by-order-id/:orderId')
  async getByOrderId(@Param('orderId') orderId: string) {
    return this.ordersService.findByOrderId(orderId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.ordersService.findById(id);
  }

  @Patch(':id')
  async updateCustomerInfo(
    @Param('id') id: string,
    @Body() body: UpdateOrderCustomerDto,
    @Request() request: AuthRequest,
  ): Promise<OrderResponseDto> {
    const updated = await this.ordersService.updateOrder(id, body);
    await this.auditService.record(request.user ?? null, 'order.update', {
      type: 'order',
      id,
    });
    return updated;
  }

  @Post(':id/tax-invoice')
  async convertToTaxInvoice(
    @Param('id') id: string,
    @Request() request: AuthRequest,
  ): Promise<OrderResponseDto> {
    const updated = await this.ordersService.convertToTaxInvoice(id);
    await this.auditService.record(
      request.user ?? null,
      'order.tax_invoice.create',
      { type: 'order', id },
      { invoiceNumber: updated.invoiceNumber ?? '' },
    );
    return updated;
  }

  @Delete(':id')
  async deleteOrder(
    @Param('id') id: string,
    @Body() body: DeleteOrderDto,
    @Request() request: AuthRequest,
  ): Promise<OrderResponseDto> {
    const actor = request.user;
    if (!actor) throw new Error('Authenticated user is required');
    await this.authService.confirmPassword(actor.id, body.password);
    const deleted = await this.ordersService.deleteOrder(id);
    await this.auditService.record(
      actor,
      'order.delete',
      { type: 'order', id },
      { orderNumber: deleted.orderNumber ?? deleted.orderId },
    );
    return deleted;
  }

  @Post(':id/payments')
  async addPayment(
    @Param('id') id: string,
    @Body() body: AddPaymentDto,
    @Request() request: AuthRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const updated = await this.ordersService.addPayment(
      id,
      body.amount,
      body.method,
      body.note,
      idempotencyKey,
    );
    await this.auditService.record(
      request.user ?? null,
      'order.payment.add',
      { type: 'order', id },
      { amount: body.amount, method: body.method },
    );
    return updated;
  }
}
