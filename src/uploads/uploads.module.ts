import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Upload, UploadSchema } from './schemas/upload.schema';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { S3Service } from './s3/s3.service';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Order, OrderSchema } from '../orders/orders.schema';

@Module({
  imports: [
    AuthModule,
    NotificationsModule,
    MongooseModule.forFeature([
      { name: Upload.name, schema: UploadSchema },
      { name: Order.name, schema: OrderSchema },
    ]),
  ],
  controllers: [UploadsController],
  providers: [UploadsService, S3Service],
  exports: [UploadsService, S3Service, MongooseModule],
})
export class UploadsModule {}
