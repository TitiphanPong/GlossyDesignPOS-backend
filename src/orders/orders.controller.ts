import { Controller, Post, Body, Get } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { Order } from './orders.schema';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  async create(@Body() order: Partial<Order>) {
    return this.ordersService.create(order);
  }

  @Get()
  async findAll() {
    return this.ordersService.findAll();
  }

  @Get('summary')
  async getSummary() {
    return this.ordersService.getSummary();
  }
}
