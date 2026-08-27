import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../auth/auth.decorators';
import { TrackingLookupDto } from './dto/tracking-lookup.dto';
import { PublicTrackingResponseDto } from './dto/tracking-response.dto';
import { OrdersService } from './orders.service';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('lookup')
  @Public()
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async lookup(
    @Body() body: TrackingLookupDto,
  ): Promise<PublicTrackingResponseDto> {
    const result = await this.ordersService.lookupPublicTracking(
      body.orderNumber,
      body.phoneSuffix,
    );
    if (!result) {
      throw new NotFoundException('Order not found');
    }
    return result;
  }
}
