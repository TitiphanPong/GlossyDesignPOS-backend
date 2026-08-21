import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { Order, OrderSchema } from './orders.schema';
import { Counter, CounterSchema } from '../counters/counters.schema';
import { OrdersSseService } from './orders.sse.service';
import { RunningNumberService } from '../counters/running-number.service';
import { AuthModule } from '../auth/auth.module';
import { Product, ProductSchema } from '../products/product.schema';
import {
  QuickProduct,
  QuickProductSchema,
} from '../quick-products/quick-product.schema';
import { OrderPricingService } from './order-pricing.service';
import { OrderReportingService } from './order-reporting.service';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: Product.name, schema: ProductSchema },
      { name: QuickProduct.name, schema: QuickProductSchema },
    ]),
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    RunningNumberService,
    OrdersSseService,
    OrderPricingService,
    OrderReportingService,
  ],
  exports: [OrderReportingService],
})
export class OrdersModule {}
