// src/orders/orders.controller.ts
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Sse,
  Request,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { UpdateOrderCustomerDto } from './dto/update-order-customer.dto';
import {
  AddPaymentDto,
  CreateOrderDto,
  UpdateOrderStatusDto,
} from './dto/order.dto';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly ordersSse: OrdersSseService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  async create(
    @Body() order: CreateOrderDto,
    @Request() request: AuthRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    const created = await this.ordersService.create(order, idempotencyKey);
    await this.auditService.record(request.user ?? null, 'order.create', {
      type: 'order',
      id: created._id,
    });
    return created;
  }

  @Get()
  async findAll(@Query('q') q?: string) {
    if (q?.trim()) {
      return this.ordersService.trackOrder(q);
    }
    return this.ordersService.findAll();
  }

  @Get('summary')
  async getSummary() {
    return this.ordersService.getSummary();
  }

  // ✅ SSE stream สำหรับหน้า Customer
  @Sse('events')
  events(): Observable<any> {
    return this.ordersSse.asObservable();
  }

  @Get('track')
  async track(@Query('q') q?: string) {
    return this.ordersService.trackOrder(q);
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

  @Post(':id/payments')
  async addPayment(
    @Param('id') id: string,
    @Body() body: AddPaymentDto,
    @Request() request: AuthRequest,
  ) {
    const updated = await this.ordersService.addPayment(
      id,
      body.amount,
      body.method,
      body.note,
    );
    await this.auditService.record(
      request.user ?? null,
      'order.payment.add',
      { type: 'order', id },
      { amount: body.amount, method: body.method },
    );
    return updated;
  }

  @Patch(':id/payments')
  async addPaymentLegacy(
    @Param('id') id: string,
    @Body() body: AddPaymentDto,
    @Request() request: AuthRequest,
  ) {
    return this.addPayment(id, body, request);
  }
}
