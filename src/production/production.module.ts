import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { User, UserSchema } from '../auth/schemas/user.schema';
import { Order, OrderSchema } from '../orders/orders.schema';
import { Upload, UploadSchema } from '../uploads/schemas/upload.schema';
import { ProductionController } from './production.controller';
import { ProductionService } from './production.service';
import {
  ProductionJob,
  ProductionJobSchema,
} from './schemas/production-job.schema';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: ProductionJob.name, schema: ProductionJobSchema },
      { name: Order.name, schema: OrderSchema },
      { name: Upload.name, schema: UploadSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [ProductionController],
  providers: [ProductionService],
  exports: [ProductionService, MongooseModule],
})
export class ProductionModule {}
