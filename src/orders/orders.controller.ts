// src/orders/orders.controller.ts
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Sse,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { OrdersService } from './orders.service';
import { OrdersSseService } from './orders.sse.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { Order } from './orders.schema';
import { UpdateOrderCustomerDto } from './dto/update-order-customer.dto';

@Controller('orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly ordersSse: OrdersSseService,
  ) {}

  @Post()
  async create(
    @Body() order: Partial<Order>,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    return this.ordersService.create(order, idempotencyKey);
  }

  @Get()
  async findAll() {
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

  // (ตัวเลือก) Endpoint ดึงออเดอร์ล่าสุดที่เป็น active (pending/paid)
  @Get('latest')
  async latestActive() {
    return this.ordersService.findLatestActive();
  }

  // (ตัวเลือก) Endpoint เปลี่ยนสถานะ แบบเรียบง่าย
  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: { status: 'pending' | 'paid' | 'cancelled' },
  ) {
    return this.ordersService.updateStatus(id, body.status);
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
  ): Promise<OrderResponseDto> {
    return this.ordersService.updateCustomerInfo(id, body);
  }

  @Patch(':id/payments')
  async addPayment(
    @Param('id') id: string,
    @Body() body: { amount: number; method: 'cash' | 'promptpay' },
  ) {
    return this.ordersService.addPayment(id, body.amount, body.method);
  }
}
