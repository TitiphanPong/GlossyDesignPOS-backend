import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Order, OrderSchema } from '../orders/orders.schema';
import { Upload, UploadSchema } from '../uploads/schemas/upload.schema';
import { OrdersModule } from '../orders/orders.module';
import {
  StockItem,
  StockItemSchema,
} from '../inventory/schemas/stock-item.schema';
import {
  ProductionJob,
  ProductionJobSchema,
} from '../production/schemas/production-job.schema';

@Module({
  imports: [
    OrdersModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Upload.name, schema: UploadSchema },
      { name: StockItem.name, schema: StockItemSchema },
      { name: ProductionJob.name, schema: ProductionJobSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
