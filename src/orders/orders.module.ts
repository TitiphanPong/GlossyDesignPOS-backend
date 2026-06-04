import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './orders.schema';
import { Counter, CounterSchema } from '../counters/counters.schema';
import { OrdersSseService } from './orders.sse.service';
import { RunningNumberService } from '../counters/running-number.service';
import { TrackingController } from '../tracking/tracking.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
  ],
  controllers: [OrdersController, TrackingController],
  providers: [OrdersService, RunningNumberService, OrdersSseService],
})
export class OrdersModule {}
