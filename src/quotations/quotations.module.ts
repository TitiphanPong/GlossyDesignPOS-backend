import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Counter, CounterSchema } from '../counters/counters.schema';
import { RunningNumberService } from '../counters/running-number.service';
import { Customer, CustomerSchema } from '../customers/schemas/customer.schema';
import { OrderPricingService } from '../orders/order-pricing.service';
import { Order, OrderSchema } from '../orders/orders.schema';
import { Product, ProductSchema } from '../products/product.schema';
import {
  QuickProduct,
  QuickProductSchema,
} from '../quick-products/quick-product.schema';
import { Quotation, QuotationSchema } from './quotation.schema';
import { QuotationsController } from './quotations.controller';
import { QuotationsService } from './quotations.service';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: Quotation.name, schema: QuotationSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Customer.name, schema: CustomerSchema },
      { name: Counter.name, schema: CounterSchema },
      { name: Product.name, schema: ProductSchema },
      { name: QuickProduct.name, schema: QuickProductSchema },
    ]),
  ],
  controllers: [QuotationsController],
  providers: [QuotationsService, OrderPricingService, RunningNumberService],
  exports: [QuotationsService],
})
export class QuotationsModule {}
