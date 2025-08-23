import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { PaymentsModule } from './modules/payments/payments.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { PricingModule } from './modules/pricing/pricing.module';
import { ProductModule } from './products/product.module';



@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
    // เสิร์ฟไฟล์ที่อัปโหลดเป็น static
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'uploads'),
      serveRoot: '/files',
    }),

    PaymentsModule,
    UploadsModule,
    PricingModule,

    //Product Module
    ProductModule,
  ],
})
export class AppModule {}