import ExcelJS from 'exceljs';
import { Model } from 'mongoose';
import {
  OrderReportingService,
  OrderReportSummary,
} from './order-reporting.service';
import { OrderDocument } from './orders.schema';

type ExportBuilder = {
  buildWorkbook(
    orders: Array<Record<string, unknown>>,
    summary: OrderReportSummary,
    saleMonth?: string,
  ): Promise<Buffer>;
  buildPdf(
    orders: Array<Record<string, unknown>>,
    summary: OrderReportSummary,
    saleMonth?: string,
  ): Promise<Buffer>;
};

describe('OrderReportingService', () => {
  const service = new OrderReportingService({} as Model<OrderDocument>);
  const builders = service as unknown as ExportBuilder;
  const summary: OrderReportSummary = {
    sales: 1250,
    collections: 750,
    outstanding: 500,
    orders: 2,
    paidOrders: 1,
    cancelledOrders: 0,
  };
  const orders = [
    {
      _id: 'order-1',
      orderId: 'order-1',
      orderNumber: '=DANGEROUS',
      saleDate: new Date('2026-08-01T00:00:00.000Z'),
      createdAt: new Date('2026-08-01T00:05:00.000Z'),
      customerName: 'ลูกค้าทดสอบ',
      phoneNumber: '0812345678',
      orderType: 'NORMAL',
      cart: [{ name: 'นามบัตร', qty: 2 }],
      payment: 'promptpay',
      status: 'partial',
      grandTotal: 1250,
      paidAmount: 750,
      remainingTotal: 500,
    },
  ];

  it('resolves Bangkok calendar-month boundaries and previous month', () => {
    const period = service.resolveDashboardPeriod({
      period: 'month',
      month: '2026-08',
    });
    expect(period.current.start.toISOString()).toBe('2026-07-31T17:00:00.000Z');
    expect(period.current.end.toISOString()).toBe('2026-08-31T17:00:00.000Z');
    expect(period.previous.start.toISOString()).toBe(
      '2026-06-30T17:00:00.000Z',
    );
    expect(period.previous.end.toISOString()).toBe('2026-07-31T17:00:00.000Z');
  });

  it('builds a saleDate filter with createdAt fallback for the selected month', () => {
    const filter = service.buildOrderFilter({ saleMonth: '2026-08' });
    const serialized = JSON.stringify(filter);
    expect(serialized).toContain('2026-07-31T17:00:00.000Z');
    expect(serialized).toContain('2026-08-31T17:00:00.000Z');
    expect(serialized).toContain('saleDate');
    expect(serialized).toContain('createdAt');
  });

  it('creates a real XLSX with Thai text, leading-zero phone and formula-safe strings', async () => {
    const buffer = await builders.buildWorkbook(orders, summary, '2026-08');
    expect(buffer.subarray(0, 2).toString()).toBe('PK');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet('Orders');
    expect(sheet?.getCell('D6').value).toBe('ลูกค้าทดสอบ');
    expect(sheet?.getCell('E6').value).toBe('0812345678');
    expect(sheet?.getCell('C6').value).toBe("'=DANGEROUS");
  });

  it('creates a real PDF buffer with the Thai font embedded', async () => {
    const buffer = await builders.buildPdf(orders, summary, '2026-08');
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(5_000);
  });
});
