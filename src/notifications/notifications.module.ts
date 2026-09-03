import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Notification, NotificationSchema } from './notifications.schema';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { Order, OrderSchema } from '../orders/orders.schema';
import {
  StockItem,
  StockItemSchema,
} from '../inventory/schemas/stock-item.schema';
import {
  ProductionJob,
  ProductionJobSchema,
} from '../production/schemas/production-job.schema';
import {
  NotificationUserState,
  NotificationUserStateSchema,
} from './notification-user-state.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: NotificationUserState.name, schema: NotificationUserStateSchema },
      { name: Order.name, schema: OrderSchema },
      { name: StockItem.name, schema: StockItemSchema },
      { name: ProductionJob.name, schema: ProductionJobSchema },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
