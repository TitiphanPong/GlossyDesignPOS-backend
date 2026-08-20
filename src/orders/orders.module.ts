import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './orders.schema';
import { Counter, CounterSchema } from '../counters/counters.schema';
import { OrdersSseService } from './orders.sse.service';
import { RunningNumberService } from '../counters/running-number.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Counter.name, schema: CounterSchema },
    ]),
  ],
  controllers: [OrdersController],
  providers: [OrdersService, RunningNumberService, OrdersSseService],
})
export class OrdersModule {}
