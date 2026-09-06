import { Controller, Get, Query, Request, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuditService } from '../../auth/audit.service';
import { AuthenticatedUser } from '../../auth/auth.types';
import { TaxInvoiceReportService } from './tax-invoice-report.service';
import { TaxInvoiceExportResult } from './tax-invoice-report.types';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('reports/tax-invoices')
export class TaxInvoiceReportController {
  constructor(
    private readonly reportService: TaxInvoiceReportService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  getMonthlyReport(@Query('period') period: string) {
    return this.reportService.getMonthlyReport(period);
  }

  @Get('export/excel')
  async exportExcel(
    @Query('period') period: string,
    @Request() request: AuthRequest,
    @Res() response: Response,
  ): Promise<void> {
    const exported = await this.reportService.exportExcel(period);
    await this.sendExport(response, exported, request.user, period, 'excel');
  }

  @Get('export/summary-pdf')
  async exportSummaryPdf(
    @Query('period') period: string,
    @Request() request: AuthRequest,
    @Res() response: Response,
  ): Promise<void> {
    const exported = await this.reportService.exportSummaryPdf(period);
    await this.sendExport(
      response,
      exported,
      request.user,
      period,
      'summary_pdf',
    );
  }

  @Get('export/invoices-pdf')
  async exportInvoicesPdf(
    @Query('period') period: string,
    @Request() request: AuthRequest,
    @Res() response: Response,
  ): Promise<void> {
    const exported = await this.reportService.exportInvoicesPdf(period);
    await this.sendExport(
      response,
      exported,
      request.user,
      period,
      'invoices_pdf',
    );
  }

  private async sendExport(
    response: Response,
    exported: TaxInvoiceExportResult,
    user: AuthenticatedUser | undefined,
    period: string,
    format: 'excel' | 'summary_pdf' | 'invoices_pdf',
  ): Promise<void> {
    await this.auditService.record(
      user ?? null,
      'tax_invoice.report.export',
      { type: 'tax_invoice_report', id: period },
      {
        format,
        count: exported.count,
        reviewCount: exported.reviewCount,
        period,
      },
    );
    response.setHeader('Content-Type', exported.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${exported.filename}"`,
    );
    response.setHeader('Content-Length', String(exported.buffer.length));
    response.setHeader('Cache-Control', 'no-store');
    response.end(exported.buffer);
  }
}
