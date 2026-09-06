import { UnprocessableEntityException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import {
  buildTaxInvoiceMonthlyReportFromOrders,
  TaxInvoiceReportService,
} from './tax-invoice-report.service';

type TestOrder = Parameters<
  typeof buildTaxInvoiceMonthlyReportFromOrders
>[1][number];

function order(overrides: Partial<TestOrder> = {}): TestOrder {
  return {
    _id: 'mongo-1',
    orderId: 'order-1',
    orderNumber: 'ORD-0001',
    saleDate: new Date('2026-08-10T05:00:00.000Z'),
    createdAt: new Date('2026-08-10T05:00:00.000Z'),
    invoiceNumber: 'INV-202608-001-001',
    bookNo: '001',
    invoiceSequence: '001',
    invoicePeriod: '202608',
    customerName: 'บริษัท ทดสอบ จำกัด',
    customerAddress: 'กรุงเทพฯ',
    taxId: '0012345678901',
    branchNo: '00001',
    subtotal: 100.1,
    discount: 0.05,
    vatAmount: 7,
    grandTotal: 107.05,
    payment: 'cash',
    status: 'paid',
    taxInvoice: 'yes',
    cart: [{ name: 'งานพิมพ์', qty: 1, unitPrice: 100.1, totalPrice: 100.1 }],
    ...overrides,
  };
}

function fakeModel(orders: TestOrder[]) {
  return {
    find: jest.fn().mockImplementation(() => ({
      lean: () => ({
        cursor: () => ({
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              next: () =>
                Promise.resolve(
                  index < orders.length
                    ? { value: orders[index++], done: false }
                    : { value: undefined, done: true },
                ),
            };
          },
        }),
      }),
    })),
  };
}

function countPdfPages(buffer: Buffer): number {
  return buffer.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

describe('TaxInvoiceReportService', () => {
  it('uses persisted invoicePeriod and preserves satang totals without payment coupling', () => {
    const report = buildTaxInvoiceMonthlyReportFromOrders('202608', [
      order(),
      order({
        _id: 'mongo-2',
        orderId: 'order-2',
        orderNumber: 'ORD-0002',
        invoiceNumber: 'INV-202608-001-002',
        invoiceSequence: '002',
        subtotal: 200.2,
        discount: 0.1,
        vatAmount: 14.01,
        grandTotal: 214.11,
      }),
    ]);

    expect(report.summary.documentCount).toBe(2);
    expect(report.summary.taxableBase).toBe(300.15);
    expect(report.summary.vatAmount).toBe(21.01);
    expect(report.summary.grandTotal).toBe(321.16);
    expect(report.documents[0]).toMatchObject({
      invoicePeriodSource: 'invoicePeriod',
      taxableBase: 100.05,
      taxId: '0012345678901',
      branch: '00001',
    });
  });

  it('falls back to legacy total when historical orders do not store subtotal', () => {
    const report = buildTaxInvoiceMonthlyReportFromOrders('202608', [
      order({ subtotal: undefined, total: 100.1, discount: 0.05 }),
    ]);

    expect(report.documents[0]).toMatchObject({
      subtotal: 100.1,
      discount: 0.05,
      taxableBase: 100.05,
    });
    expect(report.summary.taxableBase).toBe(100.05);
  });

  it('falls back from missing invoicePeriod to saleDate and then createdAt and flags review', () => {
    const report = buildTaxInvoiceMonthlyReportFromOrders('202608', [
      order({ invoicePeriod: undefined }),
      order({
        _id: 'mongo-2',
        orderId: 'order-2',
        orderNumber: 'ORD-0002',
        invoiceNumber: 'INV-202608-001-002',
        invoiceSequence: '002',
        invoicePeriod: undefined,
        saleDate: undefined,
        createdAt: new Date('2026-08-15T08:00:00.000Z'),
      }),
    ]);

    expect(report.documents.map((item) => item.invoicePeriodSource)).toEqual([
      'saleDate',
      'createdAt',
    ]);
    expect(report.summary.reviewCount).toBe(2);
    expect(
      report.documents[0].reviewReasons.map((reason) => reason.code),
    ).toContain('missing_invoice_period_fallback_sale_date');
    expect(
      report.documents[1].reviewReasons.map((reason) => reason.code),
    ).toContain('missing_invoice_period_fallback_created_at');
  });

  it('shows inconsistent invoice identity instead of silently dropping it', () => {
    const report = buildTaxInvoiceMonthlyReportFromOrders('202608', [
      order({
        taxInvoice: 'no',
        bookNo: undefined,
        invoiceSequence: undefined,
      }),
    ]);

    expect(report.documents).toHaveLength(1);
    expect(report.documents[0].reportStatus).toBe('needs_review');
    expect(
      report.documents[0].reviewReasons.map((reason) => reason.code),
    ).toEqual(
      expect.arrayContaining([
        'missing_book_number',
        'missing_invoice_sequence',
        'invoice_identity_without_tax_invoice_flag',
      ]),
    );
  });

  it('keeps cancelled document original VAT totals and reports prior-period cancellations separately', () => {
    const currentCancelled = order({
      status: 'cancelled',
      cancellation: {
        reason: 'ยกเลิกงาน',
        cancelledAt: new Date('2026-08-20T03:00:00.000Z'),
        correctiveDocumentRequired: true,
        correctiveDocumentStatus: 'required',
      },
    });
    const priorCancelled = order({
      _id: 'mongo-prior',
      orderId: 'order-prior',
      orderNumber: 'ORD-PRIOR',
      invoiceNumber: 'INV-202607-001-099',
      invoicePeriod: '202607',
      invoiceSequence: '099',
      saleDate: new Date('2026-07-25T03:00:00.000Z'),
      status: 'cancelled',
      cancellation: {
        reason: 'ยกเลิกเดือนถัดมา',
        cancelledAt: new Date('2026-08-05T03:00:00.000Z'),
        correctiveDocumentRequired: true,
        correctiveDocumentStatus: 'required',
      },
    });

    const report = buildTaxInvoiceMonthlyReportFromOrders('202608', [
      currentCancelled,
      priorCancelled,
    ]);

    expect(report.summary.documentCount).toBe(1);
    expect(report.summary.cancelledCount).toBe(1);
    expect(report.summary.vatAmount).toBe(7);
    expect(report.summary.cancelledOriginalTotals.vatAmount).toBe(7);
    expect(report.summary.crossPeriodCancellationCount).toBe(1);
    expect(report.crossPeriodCancellations[0]).toMatchObject({
      invoicePeriod: '202607',
      vatAmount: 7,
    });
  });

  it('handles more than 100 documents and sorts by book then sequence', () => {
    const orders = Array.from({ length: 105 }, (_, index) => {
      const absolute = index + 1;
      const book = absolute <= 100 ? '001' : '002';
      const sequence = String(
        absolute <= 100 ? absolute : absolute - 100,
      ).padStart(3, '0');
      return order({
        _id: `mongo-${absolute}`,
        orderId: `order-${absolute}`,
        orderNumber: `ORD-${String(absolute).padStart(4, '0')}`,
        invoiceNumber: `INV-202608-${book}-${sequence}`,
        bookNo: book,
        invoiceSequence: sequence,
      });
    }).reverse();

    const report = buildTaxInvoiceMonthlyReportFromOrders('202608', orders);
    expect(report.summary.documentCount).toBe(105);
    expect(report.documents[0].invoiceNumber).toBe('INV-202608-001-001');
    expect(report.documents[99].invoiceNumber).toBe('INV-202608-001-100');
    expect(report.documents[100].invoiceNumber).toBe('INV-202608-002-001');
    expect(report.documents[104].invoiceNumber).toBe('INV-202608-002-005');
  });

  it('writes identifiers as Excel text so leading zeroes survive', async () => {
    const service = new TaxInvoiceReportService(fakeModel([order()]) as never);
    const exported = await service.exportExcel('202608');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.buffer);
    const sheet = workbook.getWorksheet('ใบกำกับภาษี');

    expect(sheet?.getCell('B6').value).toBe('001');
    expect(sheet?.getCell('D6').value).toBe('001');
    expect(sheet?.getCell('G6').value).toBe('0012345678901');
    expect(sheet?.getCell('H6').value).toBe('00001');
    expect(sheet?.getColumn(7).numFmt).toBe('@');
    expect(workbook.getWorksheet('สรุป')?.getCell('B6').numFmt).toBe('0');
  });

  it('generates Thai PDF summary and combined invoice PDF from the same persisted dataset', async () => {
    const service = new TaxInvoiceReportService(fakeModel([order()]) as never);
    const summaryPdf = await service.exportSummaryPdf('202608');
    const invoicesPdf = await service.exportInvoicesPdf('202608');

    expect(summaryPdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(invoicesPdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(summaryPdf.count).toBe(1);
    expect(invoicesPdf.count).toBe(1);
    expect(countPdfPages(summaryPdf.buffer)).toBe(1);
    expect(countPdfPages(invoicesPdf.buffer)).toBe(1);
  });

  it('starts each invoice on a new page without inserting a trailing blank page', async () => {
    const service = new TaxInvoiceReportService(
      fakeModel([
        order(),
        order({
          _id: 'mongo-2',
          orderId: 'order-2',
          orderNumber: 'ORD-0002',
          invoiceNumber: 'INV-202608-001-002',
          invoiceSequence: '002',
        }),
      ]) as never,
    );

    const invoicesPdf = await service.exportInvoicesPdf('202608');

    expect(invoicesPdf.count).toBe(2);
    expect(countPdfPages(invoicesPdf.buffer)).toBe(2);
  });

  it('keeps a long invoice multipage while preserving the original cancelled totals', async () => {
    const longItems = Array.from({ length: 70 }, (_, index) => ({
      name: `รายการงานพิมพ์ลำดับ ${index + 1} รายละเอียดสำหรับทดสอบการขึ้นหน้าต่อเนื่อง`,
      qty: 1,
      unitPrice: 10,
      totalPrice: 10,
    }));
    const service = new TaxInvoiceReportService(
      fakeModel([
        order({
          status: 'cancelled',
          subtotal: 700,
          vatAmount: 49,
          grandTotal: 749,
          cart: longItems,
          cancellation: {
            reason: 'ยกเลิกงาน',
            cancelledAt: new Date('2026-08-20T03:00:00.000Z'),
            correctiveDocumentRequired: true,
            correctiveDocumentStatus: 'required',
          },
        }),
      ]) as never,
    );

    const report = await service.getMonthlyReport('202608');
    const invoicesPdf = await service.exportInvoicesPdf('202608');

    expect(report.documents[0]).toMatchObject({
      reportStatus: 'cancelled_review',
      subtotal: 700,
      vatAmount: 49,
      grandTotal: 749,
    });
    expect(countPdfPages(invoicesPdf.buffer)).toBeGreaterThan(1);
  });

  it('refuses a partial combined PDF and returns the failing document list', async () => {
    const service = new TaxInvoiceReportService(
      fakeModel([order({ invoiceSequence: undefined })]) as never,
    );

    await expect(service.exportInvoicesPdf('202608')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
