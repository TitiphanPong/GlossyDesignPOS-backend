import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import {
  QuickProduct,
  QuickProductSchema,
} from '../quick-products/quick-product.schema';
import { QuickSaleV2Controller } from './quick-sale-v2.controller';
import {
  QuickSaleV2Config,
  QuickSaleV2ConfigSchema,
} from './quick-sale-v2.schema';
import { QuickSaleV2Service } from './quick-sale-v2.service';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: QuickSaleV2Config.name, schema: QuickSaleV2ConfigSchema },
      { name: QuickProduct.name, schema: QuickProductSchema },
    ]),
  ],
  controllers: [QuickSaleV2Controller],
  providers: [QuickSaleV2Service],
})
export class QuickSaleV2Module {}
