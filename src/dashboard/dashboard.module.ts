import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { Order, OrderSchema } from '../orders/orders.schema';
import { Upload, UploadSchema } from '../uploads/schemas/upload.schema';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [
    OrdersModule,
    MongooseModule.forFeature([
      { name: Order.name, schema: OrderSchema },
      { name: Upload.name, schema: UploadSchema },
    ]),
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
