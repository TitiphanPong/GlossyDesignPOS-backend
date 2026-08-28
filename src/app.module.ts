import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env.validation';
import { OrdersModule } from './orders/orders.module';
import { ProductModule } from './products/product.module';
import { QuickProductModule } from './quick-products/quick-product.module';
import { UploadsModule } from './uploads/uploads.module';
import { HealthController } from './health.controller';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { DashboardModule } from './dashboard/dashboard.module';
import { NotificationsModule } from './notifications/notifications.module';
import { InventoryModule } from './inventory/inventory.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: `.env.${process.env.NODE_ENV || 'development'}`,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    MongooseModule.forRoot(process.env.MONGODB_URI as string),
    AuthModule,
    UploadsModule,
    OrdersModule,
    ProductModule,
    QuickProductModule,
    DashboardModule,
    NotificationsModule,
    InventoryModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
})
export class AppModule {}
