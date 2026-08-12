import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { OrdersService } from '../orders/orders.service';
import { Public } from '../auth/auth.decorators';

@Controller('tracking')
@Public()
export class TrackingController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get('search')
  search(
    @Query('orderNumber') orderNumber?: string,
    @Query('phone') phone?: string,
    @Query('q') q?: string,
  ) {
    return this.ordersService.searchTracking({ orderNumber, phone, q });
  }

  @Get('orders')
  searchOrders(@Query('q') q?: string) {
    return this.ordersService.searchTracking({ q });
  }

  @Get(':orderNumber')
  async findOne(@Param('orderNumber') orderNumber: string) {
    const order =
      await this.ordersService.findTrackingByOrderNumber(orderNumber);
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return order;
  }
}
