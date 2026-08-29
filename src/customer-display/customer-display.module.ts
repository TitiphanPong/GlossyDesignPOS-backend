import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CustomerDisplayController } from './customer-display.controller';
import { CustomerDisplayService } from './customer-display.service';
import {
  CustomerDisplaySession,
  CustomerDisplaySessionSchema,
} from './customer-display.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: CustomerDisplaySession.name,
        schema: CustomerDisplaySessionSchema,
      },
    ]),
  ],
  controllers: [CustomerDisplayController],
  providers: [CustomerDisplayService],
})
export class CustomerDisplayModule {}
