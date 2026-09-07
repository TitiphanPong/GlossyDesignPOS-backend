import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { FilterQuery, Model, Types } from 'mongoose';
import {
  buildExportFilename,
  normalizeMonthScope,
} from '../../common/export-filename';
import { Order } from '../../orders/orders.schema';
import {
  CrossPeriodCancellation,
  TaxInvoiceExportResult,
  TaxInvoiceMonthlyReport,
  TaxInvoiceRenderFailure,
  TaxInvoiceReportItem,
  TaxInvoiceReviewReason,
} from './tax-invoice-report.types';

const BANGKOK_TIMEZONE = 'Asia/Bangkok' as const;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const MONTH_PATTERN = /^\d{6}$/;
const MONEY_FORMAT = new Intl.NumberFormat('th-TH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const REVIEW_LABELS: Record<string, string> = {
  missing_invoice_number: 'ไม่มีเลขที่ใบกำกับภาษี',
  missing_book_number: 'ไม่มีเลขเล่ม',
  missing_invoice_sequence: 'ไม่มีเลขลำดับในเล่ม',
  invoice_identity_without_tax_invoice_flag:
    'พบเลขเอกสารภาษี แต่รายการไม่ได้ระบุว่าเป็นใบกำกับภาษี',
  missing_invoice_period_fallback_sale_date:
    'ข้อมูลเก่าไม่มี invoicePeriod ใช้เดือนของ saleDate แทน',
  missing_invoice_period_fallback_created_at:
    'ข้อมูลเก่าไม่มี invoicePeriod และ saleDate ใช้เดือนของ createdAt แทน',
  cancelled_requires_corrective_document:
    'ออเดอร์ถูกยกเลิก ต้องตรวจเอกสารปรับปรุงทางภาษี',
};

type RawOrder = {
  _id?: unknown;
  orderId?: string;
  orderNumber?: string;
  saleDate?: Date;
  createdAt?: Date;
  invoiceNumber?: string;
  bookNo?: string;
  invoiceSequence?: string;
  invoicePeriod?: string;
  customerName?: string;
  companyName?: string;
  address?: string;
  customerAddress?: string;
  taxId?: string;
  customerTaxId?: string;
  branch?: string;
  customerBranch?: string;
  branchType?: string;
  branchNo?: string;
  subtotal?: number;
  total?: number;
  discount?: number;
  vatAmount?: number;
  grandTotal?: number;
  payment?: string;
  paymentMethod?: string;
  note?: string;
  status?: string;
  workflowStatus?: string;
  taxInvoice?: 'yes' | 'no';
  cancellation?: {
    reason?: string;
    cancelledAt?: Date;
    cancelledBy?: string;
    refundedAmount?: number;
    correctiveDocumentRequired?: boolean;
    correctiveDocumentStatus?: 'not_required' | 'required';
  };
  cart?: Array<{
    name?: string;
    category?: string;
    qty?: number;
    unitPrice?: number;
    totalPrice?: number;
  }>;
};

type PeriodResolution = {
  period: string | null;
  source: 'invoicePeriod' | 'saleDate' | 'createdAt' | null;
  reviewReason?: TaxInvoiceReviewReason;
};

type MoneyTotalsMinor = {
  taxableBase: number;
  vatAmount: number;
  grandTotal: number;
};

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return value instanceof Types.ObjectId ? value.toHexString() : '';
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function toMinor(value: unknown): number {
  const amount = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

function fromMinor(value: number): number {
  return value / 100;
}

function formatMoney(value: number): string {
  return MONEY_FORMAT.format(value);
}

function getBangkokPeriod(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BANGKOK_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) throw new Error('Unable to resolve Bangkok period.');
  return `${year}${month}`;
}

function getBangkokMonthBounds(period: string): { start: Date; end: Date } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  const startUtc = Date.UTC(year, month - 1, 1) - BANGKOK_OFFSET_MS;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthIndex = month === 12 ? 0 : month;
  const endUtc = Date.UTC(nextYear, nextMonthIndex, 1) - BANGKOK_OFFSET_MS;
  return { start: new Date(startUtc), end: new Date(endUtc) };
}

function validatePeriod(period: string): string {
  if (!MONTH_PATTERN.test(period)) {
    throw new BadRequestException('period must use YYYYMM format.');
  }
  const month = Number(period.slice(4, 6));
  if (month < 1 || month > 12) {
    throw new BadRequestException('period contains an invalid month.');
  }
  return period;
}

function formatPeriodLabel(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  const reference = new Date(Date.UTC(year, month - 1, 15, 5));
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    month: 'long',
    year: 'numeric',
    timeZone: BANGKOK_TIMEZONE,
  }).format(reference);
}

function formatBangkokDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: BANGKOK_TIMEZONE,
  }).format(date);
}

function formatBangkokDateTime(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: BANGKOK_TIMEZONE,
  }).format(date);
}

function resolveInvoicePeriod(order: RawOrder): PeriodResolution {
  const invoicePeriod = safeString(order.invoicePeriod);
  if (MONTH_PATTERN.test(invoicePeriod)) {
    return { period: invoicePeriod, source: 'invoicePeriod' };
  }
  const saleDate = asDate(order.saleDate);
  if (saleDate) {
    return {
      period: getBangkokPeriod(saleDate),
      source: 'saleDate',
      reviewReason: {
        code: 'missing_invoice_period_fallback_sale_date',
        label: REVIEW_LABELS.missing_invoice_period_fallback_sale_date,
      },
    };
  }
  const createdAt = asDate(order.createdAt);
  if (createdAt) {
    return {
      period: getBangkokPeriod(createdAt),
      source: 'createdAt',
      reviewReason: {
        code: 'missing_invoice_period_fallback_created_at',
        label: REVIEW_LABELS.missing_invoice_period_fallback_created_at,
      },
    };
  }
  return { period: null, source: null };
}

function addReview(
  target: TaxInvoiceReviewReason[],
  code: TaxInvoiceReviewReason['code'],
): void {
  if (target.some((reason) => reason.code === code)) return;
  target.push({ code, label: REVIEW_LABELS[code] });
}

function resolveDocumentDate(order: RawOrder): Date | null {
  return asDate(order.saleDate) ?? asDate(order.createdAt);
}

function isCancelled(order: RawOrder): boolean {
  return (
    order.status === 'cancelled' ||
    order.workflowStatus === 'cancelled' ||
    Boolean(order.cancellation?.cancelledAt)
  );
}

function buildReportItem(
  order: RawOrder,
  period: PeriodResolution,
): TaxInvoiceReportItem | null {
  const documentDate = resolveDocumentDate(order);
  if (!period.period || !period.source || !documentDate) return null;

  const reviewReasons: TaxInvoiceReviewReason[] = [];
  if (period.reviewReason) reviewReasons.push(period.reviewReason);
  const invoiceNumber = safeString(order.invoiceNumber);
  const bookNo = safeString(order.bookNo);
  const invoiceSequence = safeString(order.invoiceSequence);
  if (!invoiceNumber) addReview(reviewReasons, 'missing_invoice_number');
  if (!bookNo) addReview(reviewReasons, 'missing_book_number');
  if (!invoiceSequence) addReview(reviewReasons, 'missing_invoice_sequence');
  if (order.taxInvoice !== 'yes') {
    addReview(reviewReasons, 'invoice_identity_without_tax_invoice_flag');
  }
  const cancelled = isCancelled(order);
  if (cancelled)
    addReview(reviewReasons, 'cancelled_requires_corrective_document');

  const subtotalMinor = Math.max(0, toMinor(order.subtotal ?? order.total));
  const discountMinor = Math.min(
    subtotalMinor,
    Math.max(0, toMinor(order.discount)),
  );
  const taxableBaseMinor = subtotalMinor - discountMinor;
  const vatMinor = Math.max(0, toMinor(order.vatAmount));
  const grandTotalMinor = Math.max(0, toMinor(order.grandTotal));
  const mongoId = safeId(order._id);
  const orderId = safeString(order.orderId) || mongoId;
  const id = mongoId || orderId;
  const customerName =
    safeString(order.companyName) || safeString(order.customerName) || '-';
  const customerAddress =
    safeString(order.customerAddress) || safeString(order.address) || '-';
  const taxId = safeString(order.customerTaxId) || safeString(order.taxId);
  const branch =
    safeString(order.branchNo) ||
    safeString(order.customerBranch) ||
    safeString(order.branch) ||
    safeString(order.branchType);
  const cancellationDate = asDate(order.cancellation?.cancelledAt);

  return {
    id,
    orderId,
    orderNumber: safeString(order.orderNumber) || orderId,
    documentDate: documentDate.toISOString(),
    invoicePeriod: period.period,
    invoicePeriodSource: period.source,
    invoiceNumber,
    bookNo,
    invoiceSequence,
    customerName,
    customerAddress,
    taxId,
    branch,
    subtotal: fromMinor(subtotalMinor),
    discount: fromMinor(discountMinor),
    taxableBase: fromMinor(taxableBaseMinor),
    vatAmount: fromMinor(vatMinor),
    grandTotal: fromMinor(grandTotalMinor),
    paymentMethod:
      safeString(order.paymentMethod) || safeString(order.payment) || '-',
    note: safeString(order.note),
    status: safeString(order.status) || safeString(order.workflowStatus) || '-',
    reportStatus: cancelled
      ? 'cancelled_review'
      : reviewReasons.length > 0
        ? 'needs_review'
        : 'issued',
    reviewReasons,
    ...(cancellationDate
      ? {
          cancellation: {
            cancelledAt: cancellationDate.toISOString(),
            reason: safeString(order.cancellation?.reason) || '-',
            correctiveDocumentRequired: Boolean(
              order.cancellation?.correctiveDocumentRequired,
            ),
            correctiveDocumentStatus:
              order.cancellation?.correctiveDocumentStatus ?? 'not_required',
          },
        }
      : {}),
    items: (order.cart ?? []).map((item) => ({
      name: safeString(item.name) || safeString(item.category) || '-',
      quantity: Number.isFinite(Number(item.qty)) ? Number(item.qty) : 0,
      unitPrice: fromMinor(toMinor(item.unitPrice)),
      amount: fromMinor(toMinor(item.totalPrice)),
    })),
  };
}

function compareInvoiceIdentity(
  left: TaxInvoiceReportItem,
  right: TaxInvoiceReportItem,
): number {
  const bookLeft = left.bookNo || '\uffff';
  const bookRight = right.bookNo || '\uffff';
  const byBook = bookLeft.localeCompare(bookRight, 'en', { numeric: true });
  if (byBook !== 0) return byBook;
  const seqLeft = left.invoiceSequence || '\uffff';
  const seqRight = right.invoiceSequence || '\uffff';
  const bySequence = seqLeft.localeCompare(seqRight, 'en', { numeric: true });
  if (bySequence !== 0) return bySequence;
  const byDate = left.documentDate.localeCompare(right.documentDate);
  if (byDate !== 0) return byDate;
  return left.orderNumber.localeCompare(right.orderNumber, 'en', {
    numeric: true,
  });
}

export function buildTaxInvoiceMonthlyReportFromOrders(
  periodValue: string,
  rawOrders: RawOrder[],
  generatedAt = new Date(),
): TaxInvoiceMonthlyReport {
  const period = validatePeriod(periodValue);
  const documents: TaxInvoiceReportItem[] = [];
  const crossPeriodCancellations: CrossPeriodCancellation[] = [];

  for (const order of rawOrders) {
    const periodResolution = resolveInvoicePeriod(order);
    const item = buildReportItem(order, periodResolution);
    if (item && item.invoicePeriod === period) documents.push(item);

    const cancelledAt = asDate(order.cancellation?.cancelledAt);
    if (
      item &&
      cancelledAt &&
      getBangkokPeriod(cancelledAt) === period &&
      item.invoicePeriod < period
    ) {
      crossPeriodCancellations.push({
        id: item.id,
        orderId: item.orderId,
        orderNumber: item.orderNumber,
        invoicePeriod: item.invoicePeriod,
        invoiceNumber: item.invoiceNumber,
        bookNo: item.bookNo,
        invoiceSequence: item.invoiceSequence,
        customerName: item.customerName,
        taxId: item.taxId,
        branch: item.branch,
        taxableBase: item.taxableBase,
        vatAmount: item.vatAmount,
        grandTotal: item.grandTotal,
        cancellation: {
          cancelledAt: cancelledAt.toISOString(),
          reason: safeString(order.cancellation?.reason) || '-',
          correctiveDocumentRequired: Boolean(
            order.cancellation?.correctiveDocumentRequired,
          ),
          correctiveDocumentStatus:
            order.cancellation?.correctiveDocumentStatus ?? 'not_required',
        },
      });
    }
  }

  documents.sort(compareInvoiceIdentity);
  crossPeriodCancellations.sort((left, right) =>
    left.cancellation.cancelledAt.localeCompare(right.cancellation.cancelledAt),
  );

  const totals: MoneyTotalsMinor = {
    taxableBase: 0,
    vatAmount: 0,
    grandTotal: 0,
  };
  const cancelledTotals: MoneyTotalsMinor = {
    taxableBase: 0,
    vatAmount: 0,
    grandTotal: 0,
  };
  let cancelledCount = 0;
  let reviewCount = 0;

  for (const document of documents) {
    totals.taxableBase += toMinor(document.taxableBase);
    totals.vatAmount += toMinor(document.vatAmount);
    totals.grandTotal += toMinor(document.grandTotal);
    if (document.reportStatus !== 'issued') reviewCount += 1;
    if (document.reportStatus === 'cancelled_review') {
      cancelledCount += 1;
      cancelledTotals.taxableBase += toMinor(document.taxableBase);
      cancelledTotals.vatAmount += toMinor(document.vatAmount);
      cancelledTotals.grandTotal += toMinor(document.grandTotal);
    }
  }

  return {
    period,
    periodLabel: formatPeriodLabel(period),
    generatedAt: generatedAt.toISOString(),
    timezone: BANGKOK_TIMEZONE,
    summary: {
      documentCount: documents.length,
      taxableBase: fromMinor(totals.taxableBase),
      vatAmount: fromMinor(totals.vatAmount),
      grandTotal: fromMinor(totals.grandTotal),
      cancelledCount,
      cancelledOriginalTotals: {
        taxableBase: fromMinor(cancelledTotals.taxableBase),
        vatAmount: fromMinor(cancelledTotals.vatAmount),
        grandTotal: fromMinor(cancelledTotals.grandTotal),
      },
      reviewCount,
      crossPeriodCancellationCount: crossPeriodCancellations.length,
    },
    documents,
    crossPeriodCancellations,
  };
}

function statusLabel(document: TaxInvoiceReportItem): string {
  if (document.reportStatus === 'cancelled_review')
    return 'ยกเลิก — ต้องตรวจเอกสารปรับปรุง';
  if (document.reportStatus === 'needs_review') return 'ต้องตรวจสอบ';
  return 'ออกเอกสารแล้ว';
}

function styleHeaderRow(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF16354D' },
  };
  row.alignment = { vertical: 'middle', wrapText: true };
}

function applyTextColumns(sheet: ExcelJS.Worksheet, columns: number[]): void {
  for (const index of columns) sheet.getColumn(index).numFmt = '@';
}

function applyMoneyColumns(sheet: ExcelJS.Worksheet, columns: number[]): void {
  for (const index of columns) sheet.getColumn(index).numFmt = '#,##0.00';
}

function addGeneratedHeader(
  sheet: ExcelJS.Worksheet,
  title: string,
  report: TaxInvoiceMonthlyReport,
): void {
  sheet.addRow([title]);
  sheet.addRow([`งวด ${report.periodLabel} (${report.period})`]);
  sheet.addRow([
    `สร้างรายงาน ${formatBangkokDateTime(report.generatedAt)} · เวลา ${BANGKOK_TIMEZONE}`,
  ]);
  sheet.addRow([]);
  sheet.getRow(1).font = { bold: true, size: 16 };
  sheet.getRow(2).font = { bold: true };
}

function companyInfo() {
  return {
    thaiName:
      process.env.COMPANY_THAI_NAME?.trim() ||
      process.env.NEXT_PUBLIC_COMPANY_THAI_NAME?.trim() ||
      'Glossy Design',
    englishName:
      process.env.COMPANY_ENGLISH_NAME?.trim() ||
      process.env.NEXT_PUBLIC_COMPANY_ENGLISH_NAME?.trim() ||
      'Glossy Design',
    branch:
      process.env.COMPANY_BRANCH_NO?.trim() ||
      process.env.NEXT_PUBLIC_COMPANY_BRANCH_NO?.trim() ||
      '-',
    taxId:
      process.env.COMPANY_TAX_ID?.trim() ||
      process.env.NEXT_PUBLIC_COMPANY_TAX_ID?.trim() ||
      '-',
    address:
      process.env.COMPANY_ADDRESS?.trim() ||
      process.env.NEXT_PUBLIC_COMPANY_ADDRESS?.trim() ||
      '-',
    phone:
      process.env.COMPANY_PHONE?.trim() ||
      process.env.NEXT_PUBLIC_COMPANY_PHONE?.trim() ||
      '-',
  };
}

const THAI_DIGITS = [
  '',
  'หนึ่ง',
  'สอง',
  'สาม',
  'สี่',
  'ห้า',
  'หก',
  'เจ็ด',
  'แปด',
  'เก้า',
];
const THAI_POSITIONS = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน', 'ล้าน'];

function thaiInteger(value: number): string {
  if (value === 0) return 'ศูนย์';
  if (value >= 1_000_000) {
    const millions = Math.floor(value / 1_000_000);
    const remainder = value % 1_000_000;
    return `${thaiInteger(millions)}ล้าน${remainder ? thaiInteger(remainder) : ''}`;
  }
  const digits = String(value).split('').map(Number);
  const last = digits.length - 1;
  let result = '';
  digits.forEach((digit, index) => {
    if (digit === 0) return;
    const position = last - index;
    if (position === 0 && digit === 1 && digits.length > 1) {
      result += 'เอ็ด';
    } else if (position === 1 && digit === 1) {
      result += 'สิบ';
    } else if (position === 1 && digit === 2) {
      result += 'ยี่สิบ';
    } else {
      result += `${THAI_DIGITS[digit]}${THAI_POSITIONS[position]}`;
    }
  });
  return result;
}

function thaiMoney(value: number): string {
  const minor = Math.max(0, toMinor(value));
  const baht = Math.floor(minor / 100);
  const satang = minor % 100;
  return satang === 0
    ? `${thaiInteger(baht)}บาทถ้วน`
    : `${thaiInteger(baht)}บาท${thaiInteger(satang)}สตางค์`;
}

@Injectable()
export class TaxInvoiceReportService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<Order>,
  ) {}

  async getMonthlyReport(
    periodValue: string,
  ): Promise<TaxInvoiceMonthlyReport> {
    const period = validatePeriod(periodValue);
    const filter = this.buildQuery(period);
    const cursor = this.orderModel
      .find(filter)
      .lean()
      .cursor({ batchSize: 250 });
    const orders: RawOrder[] = [];
    for await (const order of cursor) orders.push(order);
    return buildTaxInvoiceMonthlyReportFromOrders(period, orders);
  }

  async exportExcel(period: string): Promise<TaxInvoiceExportResult> {
    const report = await this.getMonthlyReport(period);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Glossy POS';
    workbook.created = new Date(report.generatedAt);

    const summary = workbook.addWorksheet('สรุป');
    addGeneratedHeader(summary, 'รายงานใบกำกับภาษีรายเดือน', report);
    const summaryRows: Array<[string, string | number]> = [
      ['จำนวนใบกำกับภาษี', report.summary.documentCount],
      ['มูลค่าก่อน VAT หลังส่วนลด', report.summary.taxableBase],
      ['VAT', report.summary.vatAmount],
      ['ยอดรวมตามเอกสาร', report.summary.grandTotal],
      ['ออเดอร์ยกเลิกในงวด', report.summary.cancelledCount],
      ['รายการต้องตรวจสอบ', report.summary.reviewCount],
      ['ยกเลิกข้ามงวดในเดือนนี้', report.summary.crossPeriodCancellationCount],
      [
        'ยอดเดิมของเอกสารยกเลิก: ฐานภาษี',
        report.summary.cancelledOriginalTotals.taxableBase,
      ],
      [
        'ยอดเดิมของเอกสารยกเลิก: VAT',
        report.summary.cancelledOriginalTotals.vatAmount,
      ],
      [
        'ยอดเดิมของเอกสารยกเลิก: รวม',
        report.summary.cancelledOriginalTotals.grandTotal,
      ],
    ];
    summary.addRow(['รายการ', 'ค่า']);
    styleHeaderRow(summary.getRow(5));
    for (const row of summaryRows) summary.addRow(row);
    applyMoneyColumns(summary, [2]);
    for (const rowNumber of [6, 10, 11, 12]) {
      summary.getCell(`B${rowNumber}`).numFmt = '0';
    }
    summary.columns = [{ width: 42 }, { width: 24 }];

    const documents = workbook.addWorksheet('ใบกำกับภาษี');
    addGeneratedHeader(documents, 'เอกสารทั้งเดือน', report);
    documents.addRow([
      'วันที่เอกสาร',
      'เล่มที่',
      'เลขที่ใบกำกับ',
      'ลำดับในเล่ม',
      'เลขที่งาน',
      'ลูกค้า / บริษัท',
      'เลขผู้เสียภาษี',
      'สาขา',
      'มูลค่าก่อน VAT หลังส่วนลด',
      'VAT',
      'ยอดรวม',
      'สถานะ',
      'ที่มางวด',
    ]);
    styleHeaderRow(documents.getRow(5));
    for (const document of report.documents) {
      documents.addRow([
        formatBangkokDate(document.documentDate),
        document.bookNo,
        document.invoiceNumber,
        document.invoiceSequence,
        document.orderNumber,
        document.customerName,
        document.taxId,
        document.branch,
        document.taxableBase,
        document.vatAmount,
        document.grandTotal,
        statusLabel(document),
        document.invoicePeriodSource,
      ]);
    }
    documents.columns = [
      16, 10, 26, 12, 18, 32, 20, 14, 22, 14, 16, 30, 16,
    ].map((width) => ({ width }));
    applyTextColumns(documents, [2, 3, 4, 5, 7, 8]);
    applyMoneyColumns(documents, [9, 10, 11]);
    documents.autoFilter = { from: 'A5', to: 'M5' };
    documents.views = [{ state: 'frozen', ySplit: 5 }];

    const review = workbook.addWorksheet('ต้องตรวจสอบ');
    addGeneratedHeader(review, 'รายการที่ต้องตรวจสอบ', report);
    review.addRow([
      'เลขที่ใบกำกับ',
      'เลขที่งาน',
      'สถานะ',
      'เหตุผลที่ต้องตรวจสอบ',
    ]);
    styleHeaderRow(review.getRow(5));
    for (const document of report.documents.filter(
      (item) => item.reportStatus !== 'issued',
    )) {
      review.addRow([
        document.invoiceNumber,
        document.orderNumber,
        statusLabel(document),
        document.reviewReasons.map((reason) => reason.label).join(' | '),
      ]);
    }
    review.columns = [
      { width: 26 },
      { width: 20 },
      { width: 34 },
      { width: 80 },
    ];
    applyTextColumns(review, [1, 2]);

    const crossPeriod = workbook.addWorksheet('ยกเลิกข้ามงวด');
    addGeneratedHeader(
      crossPeriod,
      'ใบกำกับงวดก่อนที่ยกเลิกในเดือนนี้',
      report,
    );
    crossPeriod.addRow([
      'วันที่ยกเลิก',
      'งวดใบกำกับเดิม',
      'เล่มที่',
      'เลขที่ใบกำกับ',
      'เลขที่งาน',
      'ลูกค้า / บริษัท',
      'เลขผู้เสียภาษี',
      'สาขา',
      'ฐานภาษีเดิม',
      'VAT เดิม',
      'ยอดรวมเดิม',
      'เหตุผลยกเลิก',
    ]);
    styleHeaderRow(crossPeriod.getRow(5));
    for (const item of report.crossPeriodCancellations) {
      crossPeriod.addRow([
        formatBangkokDate(item.cancellation.cancelledAt),
        item.invoicePeriod,
        item.bookNo,
        item.invoiceNumber,
        item.orderNumber,
        item.customerName,
        item.taxId,
        item.branch,
        item.taxableBase,
        item.vatAmount,
        item.grandTotal,
        item.cancellation.reason,
      ]);
    }
    crossPeriod.columns = [16, 14, 10, 26, 18, 30, 20, 14, 16, 14, 16, 44].map(
      (width) => ({ width }),
    );
    applyTextColumns(crossPeriod, [2, 3, 4, 5, 7, 8]);
    applyMoneyColumns(crossPeriod, [9, 10, 11]);

    for (const sheet of workbook.worksheets) {
      sheet.eachRow((row) => {
        row.alignment = { vertical: 'top', wrapText: true };
      });
    }

    const data = await workbook.xlsx.writeBuffer();
    return {
      buffer: Buffer.from(data),
      contentType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: buildExportFilename({
        artifact: 'tax-invoices',
        scope: normalizeMonthScope(report.period),
        extension: 'xlsx',
      }),
      count: report.summary.documentCount,
      reviewCount: report.summary.reviewCount,
    };
  }

  async exportSummaryPdf(period: string): Promise<TaxInvoiceExportResult> {
    const report = await this.getMonthlyReport(period);
    return {
      buffer: await this.buildSummaryPdf(report),
      contentType: 'application/pdf',
      filename: buildExportFilename({
        artifact: 'tax-invoices',
        variant: 'summary',
        scope: normalizeMonthScope(report.period),
        extension: 'pdf',
      }),
      count: report.summary.documentCount,
      reviewCount: report.summary.reviewCount,
    };
  }

  async exportInvoicesPdf(period: string): Promise<TaxInvoiceExportResult> {
    const report = await this.getMonthlyReport(period);
    const failures = this.validateInvoiceRenderability(report.documents);
    if (failures.length > 0) {
      throw new UnprocessableEntityException({
        message:
          'ไม่สามารถสร้าง PDF รวมได้ เพราะมีใบกำกับภาษีที่ข้อมูลเลขเอกสารไม่ครบ',
        failedDocuments: failures,
      });
    }
    return {
      buffer: await this.buildInvoicesPdf(report),
      contentType: 'application/pdf',
      filename: buildExportFilename({
        artifact: 'tax-invoices',
        scope: normalizeMonthScope(report.period),
        extension: 'pdf',
      }),
      count: report.summary.documentCount,
      reviewCount: report.summary.reviewCount,
    };
  }

  private buildQuery(period: string): FilterQuery<Order> {
    const { start, end } = getBangkokMonthBounds(period);
    const candidate = {
      $or: [
        { taxInvoice: 'yes' },
        { invoiceNumber: { $exists: true, $nin: [null, ''] } },
        { bookNo: { $exists: true, $nin: [null, ''] } },
        { invoiceSequence: { $exists: true, $nin: [null, ''] } },
      ],
    };
    const missingPeriod = {
      $or: [
        { invoicePeriod: { $exists: false } },
        { invoicePeriod: null },
        { invoicePeriod: '' },
      ],
    };
    const fallbackInMonth = {
      $or: [
        { saleDate: { $gte: start, $lt: end } },
        {
          $and: [
            {
              $or: [{ saleDate: { $exists: false } }, { saleDate: null }],
            },
            { createdAt: { $gte: start, $lt: end } },
          ],
        },
      ],
    };
    return {
      $and: [
        candidate,
        {
          $or: [
            { invoicePeriod: period },
            { $and: [missingPeriod, fallbackInMonth] },
            { 'cancellation.cancelledAt': { $gte: start, $lt: end } },
          ],
        },
      ],
    };
  }

  private validateInvoiceRenderability(
    documents: TaxInvoiceReportItem[],
  ): TaxInvoiceRenderFailure[] {
    return documents.flatMap((document) => {
      const reasons: string[] = [];
      if (!document.invoiceNumber) reasons.push('ไม่มีเลขที่ใบกำกับภาษี');
      if (!document.bookNo) reasons.push('ไม่มีเลขเล่ม');
      if (!document.invoiceSequence) reasons.push('ไม่มีเลขลำดับในเล่ม');
      if (!document.documentDate) reasons.push('ไม่มีวันที่เอกสาร');
      return reasons.length
        ? [
            {
              orderId: document.orderNumber || document.orderId,
              invoiceNumber: document.invoiceNumber || '-',
              reasons,
            },
          ]
        : [];
    });
  }

  private resolveFontDirectory(): string {
    const candidates = [
      join(__dirname, '..', '..', 'assets', 'fonts'),
      join(process.cwd(), 'src', 'assets', 'fonts'),
      join(process.cwd(), 'dist', 'assets', 'fonts'),
    ];
    const directory = candidates.find((candidate) =>
      existsSync(join(candidate, 'NotoSansThai-Variable.ttf')),
    );
    if (!directory) throw new Error('Thai PDF font assets are missing.');
    return directory;
  }

  private resolveLogoPath(): string {
    const candidates = [
      join(__dirname, '..', '..', 'assets', 'logo', 'logo_website.png'),
      join(process.cwd(), 'src', 'assets', 'logo', 'logo_website.png'),
      join(process.cwd(), 'dist', 'assets', 'logo', 'logo_website.png'),
    ];
    const logo = candidates.find((candidate) => existsSync(candidate));
    if (!logo) throw new Error('Tax invoice report logo asset is missing.');
    return logo;
  }

  private buildSummaryPdf(report: TaxInvoiceMonthlyReport): Promise<Buffer> {
    const font = join(this.resolveFontDirectory(), 'NotoSansThai-Variable.ttf');
    return new Promise((resolve, reject) => {
      const document = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 30,
        bufferPages: true,
        info: {
          Title: `Tax Invoice Monthly Report ${report.period}`,
          Author: 'Glossy POS',
        },
      });
      const chunks: Buffer[] = [];
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.registerFont('Thai', font);
      document.registerFont('ThaiBold', font);

      const pageWidth = document.page.width;
      const pageHeight = document.page.height;
      const left = 30;
      const footerY = pageHeight - document.page.margins.bottom - 24;
      const footerTop = footerY - 12;
      const navy = '#16354D';
      const muted = '#64748B';
      const text = '#172033';
      const border = '#D9E2EA';
      const columns = [
        { label: 'วันที่', width: 55 },
        { label: 'เล่ม', width: 32 },
        { label: 'เลขที่ใบกำกับ', width: 108 },
        { label: 'เลขที่งาน', width: 70 },
        { label: 'ลูกค้า / บริษัท', width: 115 },
        { label: 'เลขผู้เสียภาษี', width: 82 },
        { label: 'ฐานภาษี', width: 68 },
        { label: 'VAT', width: 54 },
        { label: 'ยอดรวม', width: 68 },
        { label: 'สถานะ', width: 94 },
      ];
      const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);

      const drawTitle = () => {
        document
          .fillColor(navy)
          .font('ThaiBold')
          .fontSize(16)
          .text('รายงานใบกำกับภาษีรายเดือน', left, 30);
        document
          .fillColor(text)
          .font('ThaiBold')
          .fontSize(10)
          .text(`งวด ${report.periodLabel} (${report.period})`, left, 55);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(7.5)
          .text(
            `สร้างรายงาน ${formatBangkokDateTime(report.generatedAt)} · ${BANGKOK_TIMEZONE}`,
            pageWidth - 300,
            35,
            { width: 270, align: 'right' },
          );
        const summaryText = [
          `เอกสาร ${report.summary.documentCount} ฉบับ`,
          `ฐานภาษี ${formatMoney(report.summary.taxableBase)}`,
          `VAT ${formatMoney(report.summary.vatAmount)}`,
          `รวม ${formatMoney(report.summary.grandTotal)}`,
          `ยกเลิก ${report.summary.cancelledCount}`,
          `ต้องตรวจ ${report.summary.reviewCount}`,
          `ยกเลิกข้ามงวด ${report.summary.crossPeriodCancellationCount}`,
        ].join('   ');
        document
          .fillColor(text)
          .font('Thai')
          .fontSize(8)
          .text(summaryText, left, 75, { width: tableWidth });
      };

      const drawTableHeader = (top: number): number => {
        document.rect(left, top, tableWidth, 22).fill(navy);
        let x = left;
        document.fillColor('#FFFFFF').font('ThaiBold').fontSize(6.5);
        for (const column of columns) {
          document.text(column.label, x + 3, top + 7, {
            width: column.width - 6,
            lineBreak: false,
            align: ['ฐานภาษี', 'VAT', 'ยอดรวม'].includes(column.label)
              ? 'right'
              : 'left',
          });
          x += column.width;
        }
        return top + 22;
      };

      const startContinuation = (): number => {
        document.addPage();
        document
          .fillColor(navy)
          .font('ThaiBold')
          .fontSize(10)
          .text(`รายงานใบกำกับภาษี · ${report.periodLabel}`, left, 30);
        return drawTableHeader(52);
      };

      drawTitle();
      let y = drawTableHeader(100);
      report.documents.forEach((item, index) => {
        document.font('Thai').fontSize(6.5);
        const customerHeight = document.heightOfString(item.customerName, {
          width: columns[4].width - 6,
        });
        const status = statusLabel(item);
        const statusHeight = document.heightOfString(status, {
          width: columns[9].width - 6,
        });
        const rowHeight = Math.max(
          23,
          Math.ceil(Math.max(customerHeight, statusHeight) + 8),
        );
        if (y + rowHeight > footerTop) y = startContinuation();
        document
          .rect(left, y, tableWidth, rowHeight)
          .fill(index % 2 ? '#F7F9FB' : '#FFFFFF');
        document
          .moveTo(left, y + rowHeight)
          .lineTo(left + tableWidth, y + rowHeight)
          .lineWidth(0.4)
          .stroke(border);
        const values = [
          formatBangkokDate(item.documentDate),
          item.bookNo || '-',
          item.invoiceNumber || '-',
          item.orderNumber,
          item.customerName,
          item.taxId || '-',
          formatMoney(item.taxableBase),
          formatMoney(item.vatAmount),
          formatMoney(item.grandTotal),
          status,
        ];
        let x = left;
        values.forEach((value, columnIndex) => {
          document
            .fillColor(text)
            .font('Thai')
            .fontSize(6.5)
            .text(value, x + 3, y + 4, {
              width: columns[columnIndex].width - 6,
              height: rowHeight - 6,
              align: columnIndex >= 6 && columnIndex <= 8 ? 'right' : 'left',
            });
          x += columns[columnIndex].width;
        });
        y += rowHeight;
      });

      if (report.documents.length === 0) {
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(10)
          .text('ไม่พบใบกำกับภาษีในงวดที่เลือก', left, y + 24, {
            width: tableWidth,
            align: 'center',
          });
      }

      const range = document.bufferedPageRange();
      for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
        document.switchToPage(range.start + pageIndex);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(7)
          .text(
            `Glossy POS · สร้าง ${formatBangkokDateTime(report.generatedAt)}`,
            left,
            footerY,
            { lineBreak: false },
          );
        document.text(
          `หน้า ${pageIndex + 1} / ${range.count}`,
          pageWidth - 120,
          footerY,
          {
            width: 90,
            align: 'right',
            lineBreak: false,
          },
        );
      }
      document.end();
    });
  }

  private buildInvoicesPdf(report: TaxInvoiceMonthlyReport): Promise<Buffer> {
    const font = join(this.resolveFontDirectory(), 'NotoSansThai-Variable.ttf');
    const logo = this.resolveLogoPath();
    const seller = companyInfo();
    return new Promise((resolve, reject) => {
      const document = new PDFDocument({
        autoFirstPage: false,
        size: 'A4',
        margin: 36,
        bufferPages: true,
        info: {
          Title: `Tax Invoices ${report.period}`,
          Author: 'Glossy POS',
        },
      });
      const chunks: Buffer[] = [];
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.registerFont('Thai', font);
      document.registerFont('ThaiBold', font);

      const drawCancellationMark = () => {
        const page = document.page;
        document.save();
        document
          .fillColor('#B91C1C')
          .fillOpacity(0.13)
          .font('ThaiBold')
          .fontSize(46)
          .rotate(-28, { origin: [page.width / 2, page.height / 2] })
          .text('ยกเลิก', 80, page.height / 2 - 25, {
            width: page.width - 160,
            align: 'center',
            lineBreak: false,
          });
        document.restore();
      };

      const drawInvoicePageHeader = (
        item: TaxInvoiceReportItem,
        continued: boolean,
      ): number => {
        const pageWidth = document.page.width;
        const left = document.page.margins.left;
        const contentWidth = pageWidth - left - document.page.margins.right;
        const rightColumnX = left + contentWidth * 0.57;
        const rightColumnWidth = contentWidth * 0.43;

        document.image(logo, left, 34, { fit: [88, 52] });
        document
          .fillColor('#111827')
          .font('ThaiBold')
          .fontSize(11)
          .text(seller.thaiName, left + 96, 36, {
            width: contentWidth * 0.39,
          });
        document
          .font('Thai')
          .fontSize(7.5)
          .text(seller.englishName, left + 96, 54, {
            width: contentWidth * 0.39,
          })
          .text(seller.address, left, 89, {
            width: contentWidth * 0.54,
            height: 29,
          })
          .text(
            `เลขประจำตัวผู้เสียภาษี ${seller.taxId} · สำนักงานใหญ่${seller.branch !== '-' ? ` (${seller.branch})` : ''} · โทร ${seller.phone}`,
            left,
            119,
            { width: contentWidth * 0.55 },
          );

        document
          .fillColor('#111827')
          .font('ThaiBold')
          .fontSize(14)
          .text(
            continued
              ? 'ใบกำกับภาษี / ใบเสร็จรับเงิน (ต่อ)'
              : 'ใบกำกับภาษี / ใบเสร็จรับเงิน',
            rightColumnX,
            36,
            { width: rightColumnWidth, align: 'right' },
          );
        document
          .font('Thai')
          .fontSize(8)
          .text(`เลขที่ใบกำกับ: ${item.invoiceNumber}`, rightColumnX, 70, {
            width: rightColumnWidth,
            align: 'right',
          })
          .text(`เล่มที่: ${item.bookNo}`, rightColumnX, 84, {
            width: rightColumnWidth,
            align: 'right',
          })
          .text(
            `วันที่: ${formatBangkokDate(item.documentDate)}`,
            rightColumnX,
            98,
            {
              width: rightColumnWidth,
              align: 'right',
            },
          )
          .text(
            `เลขที่ Order/เลขที่งาน: ${item.orderNumber}`,
            rightColumnX,
            112,
            {
              width: rightColumnWidth,
              align: 'right',
            },
          );

        const buyerTop = 146;
        const buyerHeight = 80;
        document
          .roundedRect(left, buyerTop, contentWidth, buyerHeight, 3)
          .lineWidth(0.7)
          .stroke('#94A3B8');
        document
          .fillColor('#111827')
          .font('ThaiBold')
          .fontSize(9)
          .text('ข้อมูลผู้ซื้อ / Buyer', left + 10, buyerTop + 8, {
            width: contentWidth - 20,
          });
        document
          .font('Thai')
          .fontSize(8)
          .text(`ชื่อ/บริษัท: ${item.customerName}`, left + 10, buyerTop + 25, {
            width: contentWidth - 20,
          })
          .text(
            `ที่อยู่: ${item.customerAddress || '-'}`,
            left + 10,
            buyerTop + 40,
            {
              width: contentWidth - 20,
              height: 24,
            },
          )
          .text(
            `เลขประจำตัวผู้เสียภาษี: ${item.taxId || '-'}    สาขา: ${item.branch || '-'}`,
            left + 10,
            buyerTop + 63,
            { width: contentWidth - 20 },
          );

        if (item.reportStatus === 'cancelled_review') drawCancellationMark();
        return buyerTop + buyerHeight + 14;
      };

      const drawItemHeader = (top: number): number => {
        const left = document.page.margins.left;
        const width = document.page.width - left - document.page.margins.right;
        const cols = [30, width - 30 - 48 - 72 - 82, 48, 72, 82];
        document.rect(left, top, width, 24).fill('#E5E7EB');
        const labels = ['ลำดับ', 'รายการ', 'จำนวน', 'ราคาต่อหน่วย', 'ยอดรวม'];
        let x = left;
        labels.forEach((label, index) => {
          document
            .fillColor('#111827')
            .font('ThaiBold')
            .fontSize(7.5)
            .text(label, x + 4, top + 7, {
              width: cols[index] - 8,
              align: index >= 3 ? 'right' : index === 1 ? 'left' : 'center',
              lineBreak: false,
            });
          x += cols[index];
        });
        return top + 24;
      };

      const drawItemRow = (
        item: TaxInvoiceReportItem['items'][number],
        ordinal: number,
        top: number,
      ): number => {
        const left = document.page.margins.left;
        const width = document.page.width - left - document.page.margins.right;
        const cols = [30, width - 30 - 48 - 72 - 82, 48, 72, 82];
        document.font('Thai').fontSize(8);
        const nameHeight = document.heightOfString(item.name, {
          width: cols[1] - 8,
        });
        const height = Math.max(24, Math.ceil(nameHeight + 10));
        document
          .moveTo(left, top + height)
          .lineTo(left + width, top + height)
          .lineWidth(0.4)
          .stroke('#CBD5E1');
        const values = [
          String(ordinal),
          item.name,
          String(item.quantity),
          formatMoney(item.unitPrice),
          formatMoney(item.amount),
        ];
        let x = left;
        values.forEach((value, index) => {
          document
            .fillColor('#111827')
            .font('Thai')
            .fontSize(8)
            .text(value, x + 4, top + 6, {
              width: cols[index] - 8,
              height: height - 8,
              align: index >= 3 ? 'right' : index === 1 ? 'left' : 'center',
            });
          x += cols[index];
        });
        return top + height;
      };

      const startPage = (item: TaxInvoiceReportItem, continued: boolean) => {
        document.addPage();
        const y = drawInvoicePageHeader(item, continued);
        return drawItemHeader(y);
      };

      const drawTotals = (item: TaxInvoiceReportItem, top: number) => {
        const left = document.page.margins.left;
        const width = document.page.width - left - document.page.margins.right;
        let y = top + 10;
        const moneyLine = (label: string, value: string, bold = false) => {
          document
            .fillColor('#111827')
            .font(bold ? 'ThaiBold' : 'Thai')
            .fontSize(bold ? 10 : 8.5)
            .text(label, left + width - 250, y, { width: 145, align: 'right' });
          document.text(value, left + width - 100, y, {
            width: 100,
            align: 'right',
          });
          y += bold ? 20 : 17;
        };
        moneyLine('รวมมูลค่าสินค้า', formatMoney(item.subtotal));
        if (item.discount !== 0) {
          moneyLine('ส่วนลด', `-${formatMoney(item.discount)}`);
        }
        moneyLine('มูลค่าก่อน VAT หลังส่วนลด', formatMoney(item.taxableBase));
        moneyLine('ภาษีมูลค่าเพิ่ม 7%', formatMoney(item.vatAmount));
        moneyLine('จำนวนเงินรวมทั้งสิ้น', formatMoney(item.grandTotal), true);
        document
          .font('ThaiBold')
          .fontSize(9)
          .text(`(${thaiMoney(item.grandTotal)})`, left, y + 2, {
            width,
            align: 'right',
          });
        y += 28;
        document
          .moveTo(left, y)
          .lineTo(left + width, y)
          .lineWidth(0.6)
          .stroke('#CBD5E1');
        document
          .font('Thai')
          .fontSize(8)
          .text(
            `ชำระโดย: ${item.paymentMethod || '-'}    เลขที่งาน: ${item.orderNumber}`,
            left,
            y + 12,
            {
              width,
            },
          );
        document.text(
          item.note || 'กรุณาตรวจสอบรายการและเก็บเอกสารนี้ไว้เป็นหลักฐาน',
          left,
          y + 30,
          { width },
        );
        if (item.reportStatus === 'cancelled_review') {
          document
            .fillColor('#B91C1C')
            .font('ThaiBold')
            .fontSize(8)
            .text(
              'หมายเหตุ: ออเดอร์นี้ถูกยกเลิก รายงานไม่ได้หัก VAT อัตโนมัติและไม่ได้ถือเป็นใบลดหนี้ กรุณาตรวจเอกสารปรับปรุง',
              left,
              y + 50,
              { width },
            );
        }

        const signatureTop = y + 86;
        const signatureWidth = 168;
        const receiverX = left + width - signatureWidth;
        document
          .fillColor('#111827')
          .font('Thai')
          .fontSize(8)
          .moveTo(receiverX, signatureTop + 28)
          .lineTo(receiverX + signatureWidth, signatureTop + 28)
          .lineWidth(0.5)
          .stroke('#94A3B8');
        document.text(
          'ผู้รับเงิน / ผู้มีอำนาจลงนาม',
          receiverX,
          signatureTop + 34,
          {
            width: signatureWidth,
            align: 'center',
          },
        );
        document.text(
          'วันที่ ........................................',
          receiverX,
          signatureTop + 52,
          {
            width: signatureWidth,
            align: 'center',
          },
        );
      };

      if (report.documents.length === 0) {
        document.addPage();
        document
          .fillColor('#16354D')
          .font('ThaiBold')
          .fontSize(16)
          .text('สำเนาใบกำกับภาษีประจำเดือน', 36, 60);
        document
          .fillColor('#64748B')
          .font('Thai')
          .fontSize(10)
          .text(`งวด ${report.periodLabel} — ไม่พบใบกำกับภาษี`, 36, 92);
      }

      for (const item of report.documents) {
        let y = startPage(item, false);
        for (const [itemIndex, invoiceItem] of item.items.entries()) {
          document.font('Thai').fontSize(8);
          const contentWidth =
            document.page.width -
            document.page.margins.left -
            document.page.margins.right;
          const descriptionWidth = contentWidth - 30 - 48 - 72 - 82 - 8;
          const projectedHeight = Math.max(
            24,
            Math.ceil(
              document.heightOfString(invoiceItem.name, {
                width: descriptionWidth,
              }) + 10,
            ),
          );
          if (y + projectedHeight > document.page.height - 190) {
            y = startPage(item, true);
          }
          y = drawItemRow(invoiceItem, itemIndex + 1, y);
        }
        if (y + 245 > document.page.height - 36) {
          document.addPage();
          y = drawInvoicePageHeader(item, true);
        }
        drawTotals(item, y);
      }

      const range = document.bufferedPageRange();
      for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
        document.switchToPage(range.start + pageIndex);
        const footerY =
          document.page.height - document.page.margins.bottom - 24;
        document
          .fillColor('#64748B')
          .font('Thai')
          .fontSize(6.5)
          .text(
            `รายงานงวด ${report.period} · สร้าง ${formatBangkokDateTime(report.generatedAt)}`,
            36,
            footerY,
            { lineBreak: false },
          );
        document.text(
          `หน้า ${pageIndex + 1} / ${range.count}`,
          document.page.width - 116,
          footerY,
          {
            width: 80,
            align: 'right',
            lineBreak: false,
          },
        );
      }
      document.end();
    });
  }
}
