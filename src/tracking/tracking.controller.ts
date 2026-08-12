import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { OrdersService } from '../orders/orders.service';
import {
  PublicTrackingResponseDto,
  TrackingLookupDto,
} from './dto/tracking-lookup.dto';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly ordersService: OrdersService) {}

  @Public()
  @Post('lookup')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async lookup(
    @Body() body: TrackingLookupDto,
  ): Promise<PublicTrackingResponseDto> {
    const order = await this.ordersService.lookupPublicTracking(
      body.orderNumber,
      body.phoneSuffix,
    );
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }
}
