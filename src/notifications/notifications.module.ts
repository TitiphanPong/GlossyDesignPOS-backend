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

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: Order.name, schema: OrderSchema },
      { name: StockItem.name, schema: StockItemSchema },
    ]),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
