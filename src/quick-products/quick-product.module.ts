import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { QuickProductController } from './quick-product.controller';
import { QuickProduct, QuickProductSchema } from './quick-product.schema';
import { QuickProductService } from './quick-product.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([
      { name: QuickProduct.name, schema: QuickProductSchema },
    ]),
  ],
  controllers: [QuickProductController],
  providers: [QuickProductService],
})
export class QuickProductModule {}
