import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module';
import { Order, OrderSchema } from '../orders/orders.schema';
import { TaxInvoiceReportController } from './tax-invoices/tax-invoice-report.controller';
import { TaxInvoiceReportService } from './tax-invoices/tax-invoice-report.service';

@Module({
  imports: [
    AuthModule,
    MongooseModule.forFeature([{ name: Order.name, schema: OrderSchema }]),
  ],
  controllers: [TaxInvoiceReportController],
  providers: [TaxInvoiceReportService],
})
export class ReportsModule {}
