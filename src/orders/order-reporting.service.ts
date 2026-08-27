import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import ExcelJS from 'exceljs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { FilterQuery, Model, PipelineStage } from 'mongoose';
import { DashboardSummaryQueryDto } from '../dashboard/dto/dashboard-summary-query.dto';
import {
  ExportOrdersQueryDto,
  ListOrdersQueryDto,
} from './dto/list-orders-query.dto';
import { Order, OrderDocument } from './orders.schema';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

export type ReportPeriod = {
  mode: 'today' | 'last7' | 'month' | 'custom';
  month?: string;
  from: string;
  toExclusive: string;
  label: string;
};

export type OrderReportSummary = {
  sales: number;
  collections: number;
  outstanding: number;
  orders: number;
  paidOrders: number;
  cancelledOrders: number;
};

type DateRange = { start: Date; end: Date };
type ReportOrder = Order & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  saleDate?: Date;
};
type TotalRow = {
  _id: null;
  total: number;
  count: number;
  customers?: string[];
};
type ReceivedRow = {
  received: number;
  cash: number;
  transfer: number;
  fullPayment: number;
  deposits: number;
  oldOutstandingPaid: number;
};
type TrendRow = { _id: string; revenue: number; orders: number };

function amountExpression(): Record<string, unknown> {
  return { $ifNull: ['$grandTotal', { $ifNull: ['$total', 0] }] };
}

function saleDateExpression(): Record<string, unknown> {
  return { $ifNull: ['$saleDate', '$createdAt'] };
}

function initialPaidExpression(): Record<string, unknown> {
  return {
    $max: [
      0,
      {
        $subtract: [
          { $ifNull: ['$paidAmount', { $ifNull: ['$depositTotal', 0] }] },
          {
            $sum: {
              $map: {
                input: { $ifNull: ['$payments', []] },
                as: 'payment',
                in: { $ifNull: ['$$payment.amount', 0] },
              },
            },
          },
        ],
      },
    ],
  };
}

function bangkokDayStart(value = new Date()): Date {
  const shifted = new Date(value.getTime() + BANGKOK_OFFSET_MS);
  return new Date(
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) - BANGKOK_OFFSET_MS,
  );
}

function monthRange(month: string): DateRange {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  return {
    start: new Date(Date.UTC(year, monthIndex, 1) - BANGKOK_OFFSET_MS),
    end: new Date(Date.UTC(year, monthIndex + 1, 1) - BANGKOK_OFFSET_MS),
  };
}

function bangkokDateRange(startDate: string, endDate: string): DateRange {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  return {
    start: new Date(
      Date.UTC(startYear, startMonth - 1, startDay) - BANGKOK_OFFSET_MS,
    ),
    end: new Date(
      Date.UTC(endYear, endMonth - 1, endDay + 1) - BANGKOK_OFFSET_MS,
    ),
  };
}

function previousMonthRange(range: DateRange): DateRange {
  const shifted = new Date(range.start.getTime() + BANGKOK_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const monthIndex = shifted.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, monthIndex - 1, 1) - BANGKOK_OFFSET_MS),
    end: range.start,
  };
}

function periodLabel(mode: ReportPeriod['mode'], range: DateRange): string {
  if (mode === 'today') return 'วันนี้';
  if (mode === 'last7') return 'ย้อนหลัง 7 วัน';
  if (mode === 'custom') return 'ช่วงเวลาที่เลือก';
  return new Intl.DateTimeFormat('th-TH', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  }).format(range.start);
}

function effectiveDateKey(value: Date): string {
  return new Date(value.getTime() + BANGKOK_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

function safeText(value: unknown): string {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    text = String(value);
  } else if (value instanceof Date) {
    text = value.toISOString();
  }
  return /^[\t\r\n ]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPdfMoney(value: number): string {
  return `฿${formatMoney(value)}`;
}

function formatDate(value?: Date): string {
  if (!value) return '-';
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Asia/Bangkok',
  }).format(value);
}

@Injectable()
export class OrderReportingService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
  ) {}

  resolveDashboardPeriod(query: DashboardSummaryQueryDto, now = new Date()) {
    const mode = query.period ?? 'today';
    const todayStart = bangkokDayStart(now);
    let current: DateRange = {
      start: todayStart,
      end: new Date(todayStart.getTime() + DAY_MS),
    };
    if (mode === 'month') current = monthRange(query.month as string);
    if (mode === 'last7') {
      current = {
        start: new Date(todayStart.getTime() - 6 * DAY_MS),
        end: new Date(todayStart.getTime() + DAY_MS),
      };
    }
    if (mode === 'custom') {
      current = bangkokDateRange(
        query.startDate as string,
        query.endDate as string,
      );
    }
    const previous =
      mode === 'month'
        ? previousMonthRange(current)
        : {
            start: new Date(
              current.start.getTime() -
                (current.end.getTime() - current.start.getTime()),
            ),
            end: current.start,
          };
    return { mode, current, previous };
  }

  getSaleMonthRange(saleMonth?: string): DateRange | null {
    return saleMonth ? monthRange(saleMonth) : null;
  }

  buildOrderFilter(
    query: ListOrdersQueryDto,
    options: { includeSaleMonth?: boolean } = {},
  ): FilterQuery<OrderDocument> {
    const filter: FilterQuery<OrderDocument> = {};
    const search = query.search?.trim();

    if (search) {
      const pattern = search.replace(REGEX_SPECIAL_CHARS, '\\$&');
      filter.$or = [
        { orderNumber: { $regex: pattern, $options: 'i' } },
        { orderId: { $regex: pattern, $options: 'i' } },
        { customerName: { $regex: pattern, $options: 'i' } },
        { phoneNumber: { $regex: pattern, $options: 'i' } },
        { 'cart.name': { $regex: pattern, $options: 'i' } },
      ];
    }
    if (query.status) filter.status = query.status;
    if (query.payment === 'unpaid') {
      filter.remainingTotal = { $gt: 0 };
      filter.$and = [...(filter.$and ?? []), { status: { $ne: 'cancelled' } }];
    }
    if (query.paymentMethod) filter.payment = query.paymentMethod;
    if (query.orderType) filter.orderType = query.orderType;
    if (query.taxInvoice) filter.taxInvoice = query.taxInvoice;
    if (query.entryMode && query.entryMode !== 'all') {
      filter.entryMode = query.entryMode;
    }
    if (query.createdFrom || query.createdTo) {
      filter.createdAt = {
        ...(query.createdFrom ? { $gte: new Date(query.createdFrom) } : {}),
        ...(query.createdTo ? { $lte: new Date(query.createdTo) } : {}),
      };
    }

    let saleRange: Record<string, Date> | null = null;
    if (options.includeSaleMonth !== false && query.period === 'today') {
      const start = bangkokDayStart();
      saleRange = { $gte: start, $lt: new Date(start.getTime() + DAY_MS) };
    } else if (options.includeSaleMonth !== false && query.saleMonth) {
      const range = monthRange(query.saleMonth);
      saleRange = { $gte: range.start, $lt: range.end };
    } else if (query.saleFrom || query.saleTo) {
      saleRange = {
        ...(query.saleFrom ? { $gte: new Date(query.saleFrom) } : {}),
        ...(query.saleTo ? { $lte: new Date(query.saleTo) } : {}),
      };
    }
    if (saleRange) {
      filter.$and = [
        ...(filter.$and ?? []),
        {
          $or: [
            { saleDate: saleRange },
            { saleDate: { $exists: false }, createdAt: saleRange },
          ],
        },
      ];
    }
    return filter;
  }

  getSortStage(sort: ListOrdersQueryDto['sort']): PipelineStage.Sort['$sort'] {
    if (sort === 'oldest') return { _effectiveSaleDate: 1, _id: 1 };
    if (sort === 'amount_desc') return { _effectiveTotal: -1, _id: -1 };
    if (sort === 'amount_asc') return { _effectiveTotal: 1, _id: 1 };
    return { _effectiveSaleDate: -1, _id: -1 };
  }

  listPipeline(query: ListOrdersQueryDto): PipelineStage[] {
    return [
      { $match: this.buildOrderFilter(query) },
      {
        $addFields: {
          _effectiveSaleDate: saleDateExpression(),
          _effectiveTotal: amountExpression(),
        },
      },
      { $sort: this.getSortStage(query.sort) },
    ];
  }

  async getOrderSummary(
    query: ListOrdersQueryDto,
  ): Promise<OrderReportSummary> {
    const saleFilter = this.buildOrderFilter(query);
    const collectionFilter = this.buildOrderFilter(query, {
      includeSaleMonth: false,
    });
    const paymentRange = this.getSaleMonthRange(query.saleMonth);
    const [summaryRows, collectionRows] = await Promise.all([
      this.orderModel.aggregate<{
        sales: number;
        outstanding: number;
        orders: number;
        paidOrders: number;
        cancelledOrders: number;
      }>([
        { $match: saleFilter },
        {
          $group: {
            _id: null,
            sales: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'cancelled'] },
                  0,
                  amountExpression(),
                ],
              },
            },
            outstanding: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'cancelled'] },
                  0,
                  { $ifNull: ['$remainingTotal', 0] },
                ],
              },
            },
            orders: { $sum: 1 },
            paidOrders: {
              $sum: {
                $cond: [{ $in: ['$status', ['paid', 'delivered']] }, 1, 0],
              },
            },
            cancelledOrders: {
              $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] },
            },
          },
        },
      ]),
      this.orderModel.aggregate<ReceivedRow>(
        this.receivedPipeline(paymentRange, collectionFilter),
      ),
    ]);
    const summary = summaryRows[0];
    return {
      sales: summary?.sales ?? 0,
      collections: collectionRows[0]?.received ?? 0,
      outstanding: summary?.outstanding ?? 0,
      orders: summary?.orders ?? 0,
      paidOrders: summary?.paidOrders ?? 0,
      cancelledOrders: summary?.cancelledOrders ?? 0,
    };
  }

  async getDashboardMetrics(query: DashboardSummaryQueryDto) {
    const { mode, current, previous } = this.resolveDashboardPeriod(query);
    const trendRange =
      mode === 'today'
        ? {
            start: new Date(current.start.getTime() - 6 * DAY_MS),
            end: current.end,
          }
        : current;
    const [
      currentRows,
      previousRows,
      receivedRows,
      trendRows,
      topProducts,
      quickRows,
    ] = await Promise.all([
      this.salesAggregate(current),
      this.salesAggregate(previous),
      this.orderModel.aggregate<ReceivedRow>(this.receivedPipeline(current)),
      this.orderModel.aggregate<TrendRow>([
        {
          $match: {
            $expr: {
              $and: [
                { $gte: [saleDateExpression(), trendRange.start] },
                { $lt: [saleDateExpression(), trendRange.end] },
              ],
            },
            status: { $ne: 'cancelled' },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y-%m-%d',
                date: saleDateExpression(),
                timezone: 'Asia/Bangkok',
              },
            },
            revenue: { $sum: amountExpression() },
            orders: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      this.orderModel.aggregate<{
        name: string;
        quantity: number;
        revenue: number;
      }>(this.topProductsPipeline(current, { $ne: 'QUICK_SALE' })),
      this.orderModel.aggregate<{
        orders: number;
        revenue: number;
        items: Array<{ name: string; quantity: number; revenue: number }>;
      }>(this.quickSalePipeline(current)),
    ]);

    const currentRow = currentRows[0];
    const previousRow = previousRows[0];
    const received = receivedRows[0] ?? {
      received: 0,
      cash: 0,
      transfer: 0,
      fullPayment: 0,
      deposits: 0,
      oldOutstandingPaid: 0,
    };
    const trendMap = new Map(trendRows.map((row) => [row._id, row]));
    const days = Math.round(
      (trendRange.end.getTime() - trendRange.start.getTime()) / DAY_MS,
    );
    const salesTrend = Array.from({ length: days }, (_, index) => {
      const key = effectiveDateKey(
        new Date(trendRange.start.getTime() + index * DAY_MS),
      );
      const row = trendMap.get(key);
      return {
        date: key,
        revenue: row?.revenue ?? 0,
        orders: row?.orders ?? 0,
      };
    });
    const month = mode === 'month' ? query.month : undefined;
    return {
      period: {
        mode,
        month,
        from: current.start.toISOString(),
        toExclusive: current.end.toISOString(),
        label: periodLabel(mode, current),
      } satisfies ReportPeriod,
      periodSummary: {
        sales: currentRow?.total ?? 0,
        collections: received.received,
        orders: currentRow?.count ?? 0,
        customers: currentRow?.customers?.filter(Boolean).length ?? 0,
        previousSales: previousRow?.total ?? 0,
        previousOrders: previousRow?.count ?? 0,
      },
      paymentSummary: received,
      salesTrend,
      topProducts,
      quickSeller: quickRows[0] ?? { orders: 0, revenue: 0, items: [] },
    };
  }

  async buildExport(query: ExportOrdersQueryDto) {
    const [orders, summary] = await Promise.all([
      this.orderModel.aggregate<ReportOrder>(this.listPipeline(query)),
      this.getOrderSummary(query),
    ]);
    const filenamePeriod = query.saleMonth ?? 'all';
    if (query.format === 'xlsx') {
      return {
        buffer: await this.buildWorkbook(orders, summary, query.saleMonth),
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: `orders-${filenamePeriod}.xlsx`,
        count: orders.length,
      };
    }
    return {
      buffer: await this.buildPdf(orders, summary, query.saleMonth),
      contentType: 'application/pdf',
      filename: `GlossyPOS-Sales-Statement-${filenamePeriod}.pdf`,
      count: orders.length,
    };
  }

  private async salesAggregate(range: DateRange) {
    return this.orderModel.aggregate<TotalRow>([
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [saleDateExpression(), range.start] },
              { $lt: [saleDateExpression(), range.end] },
            ],
          },
          status: { $ne: 'cancelled' },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: amountExpression() },
          count: { $sum: 1 },
          customers: { $addToSet: '$phoneNumber' },
        },
      },
    ]);
  }

  private receivedPipeline(
    range: DateRange | null,
    filter: FilterQuery<OrderDocument> = {},
  ): PipelineStage[] {
    const inRange = (value: string) =>
      range
        ? {
            $and: [{ $gte: [value, range.start] }, { $lt: [value, range.end] }],
          }
        : true;
    return [
      { $match: filter },
      {
        $project: {
          createdAt: 1,
          payment: 1,
          total: amountExpression(),
          initialPaid: initialPaidExpression(),
          payments: { $ifNull: ['$payments', []] },
        },
      },
      {
        $project: {
          initial: { $cond: [inRange('$createdAt'), '$initialPaid', 0] },
          payment: 1,
          total: 1,
          createdAt: 1,
          selectedPayments: {
            $filter: {
              input: '$payments',
              as: 'p',
              cond: inRange('$$p.paidAt'),
            },
          },
        },
      },
      {
        $project: {
          initial: 1,
          payment: 1,
          total: 1,
          paymentReceived: {
            $sum: {
              $map: { input: '$selectedPayments', as: 'p', in: '$$p.amount' },
            },
          },
          paymentCash: {
            $sum: {
              $map: {
                input: '$selectedPayments',
                as: 'p',
                in: {
                  $cond: [{ $eq: ['$$p.method', 'cash'] }, '$$p.amount', 0],
                },
              },
            },
          },
          paymentTransfer: {
            $sum: {
              $map: {
                input: '$selectedPayments',
                as: 'p',
                in: {
                  $cond: [
                    { $eq: ['$$p.method', 'promptpay'] },
                    '$$p.amount',
                    0,
                  ],
                },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          received: { $sum: { $add: ['$initial', '$paymentReceived'] } },
          cash: {
            $sum: {
              $add: [
                { $cond: [{ $eq: ['$payment', 'cash'] }, '$initial', 0] },
                '$paymentCash',
              ],
            },
          },
          transfer: {
            $sum: {
              $add: [
                { $cond: [{ $eq: ['$payment', 'promptpay'] }, '$initial', 0] },
                '$paymentTransfer',
              ],
            },
          },
          fullPayment: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$initial', 0] },
                    { $gte: ['$initial', '$total'] },
                  ],
                },
                '$initial',
                0,
              ],
            },
          },
          deposits: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$initial', 0] },
                    { $lt: ['$initial', '$total'] },
                  ],
                },
                '$initial',
                0,
              ],
            },
          },
          oldOutstandingPaid: { $sum: '$paymentReceived' },
        },
      },
      { $project: { _id: 0 } },
    ];
  }

  private topProductsPipeline(
    range: DateRange,
    orderType: Record<string, unknown>,
  ): PipelineStage[] {
    return [
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [saleDateExpression(), range.start] },
              { $lt: [saleDateExpression(), range.end] },
            ],
          },
          status: { $ne: 'cancelled' },
          orderType,
        },
      },
      { $unwind: '$cart' },
      {
        $group: {
          _id: {
            $ifNull: ['$cart.name', { $ifNull: ['$cart.category', 'ไม่ระบุ'] }],
          },
          quantity: { $sum: { $ifNull: ['$cart.qty', 0] } },
          revenue: {
            $sum: {
              $ifNull: [
                '$cart.totalPrice',
                { $ifNull: ['$cart.lineTotal', 0] },
              ],
            },
          },
        },
      },
      { $sort: { quantity: -1 } },
      { $limit: 5 },
      { $project: { _id: 0, name: '$_id', quantity: 1, revenue: 1 } },
    ];
  }

  private quickSalePipeline(range: DateRange): PipelineStage[] {
    return [
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [saleDateExpression(), range.start] },
              { $lt: [saleDateExpression(), range.end] },
            ],
          },
          status: { $ne: 'cancelled' },
          orderType: 'QUICK_SALE',
        },
      },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                orders: { $sum: 1 },
                revenue: { $sum: amountExpression() },
              },
            },
          ],
          items: [
            { $unwind: '$cart' },
            {
              $group: {
                _id: { $ifNull: ['$cart.name', '$cart.category'] },
                quantity: { $sum: { $ifNull: ['$cart.qty', 0] } },
                revenue: { $sum: { $ifNull: ['$cart.totalPrice', 0] } },
              },
            },
            { $sort: { quantity: -1 } },
            { $limit: 4 },
            { $project: { _id: 0, name: '$_id', quantity: 1, revenue: 1 } },
          ],
        },
      },
      {
        $project: {
          _id: 0,
          orders: { $ifNull: [{ $arrayElemAt: ['$totals.orders', 0] }, 0] },
          revenue: { $ifNull: [{ $arrayElemAt: ['$totals.revenue', 0] }, 0] },
          items: 1,
        },
      },
    ];
  }

  private async buildWorkbook(
    orders: ReportOrder[],
    summary: OrderReportSummary,
    saleMonth?: string,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Glossy POS';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Orders', {
      views: [{ state: 'frozen', ySplit: 5 }],
    });
    sheet.mergeCells('A1:L1');
    sheet.getCell('A1').value = `รายงานรายการงาน ${saleMonth ?? 'ทั้งหมด'}`;
    sheet.getCell('A1').font = {
      bold: true,
      size: 16,
      color: { argb: 'FFFFFFFF' },
    };
    sheet.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF1E5EFF' },
    };
    sheet.getCell('A2').value = `ยอดขาย: ${formatMoney(summary.sales)}`;
    sheet.getCell('D2').value = `ยอดรับ: ${formatMoney(summary.collections)}`;
    sheet.getCell('G2').value = `ยอดค้าง: ${formatMoney(summary.outstanding)}`;
    sheet.getCell('J2').value = `งานทั้งหมด: ${summary.orders}`;
    sheet.getCell('A3').value = `งานยกเลิก: ${summary.cancelledOrders}`;
    sheet.getCell('D3').value = `สร้างเมื่อ: ${formatDate(new Date())}`;
    sheet.addRow([]);
    const header = sheet.addRow([
      'วันที่ขาย',
      'วันที่บันทึก',
      'เลขที่งาน',
      'ลูกค้า',
      'เบอร์โทร',
      'ประเภทงาน',
      'รายการสินค้า',
      'ช่องทางชำระ',
      'สถานะ',
      'ยอดรวม',
      'ยอดรับ',
      'ยอดค้าง',
    ]);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2A4365' },
    };
    header.alignment = { vertical: 'middle', horizontal: 'center' };
    for (const order of orders) {
      const paid = Number(order.paidAmount ?? order.depositTotal ?? 0);
      const total = Number(order.grandTotal ?? order.total ?? 0);
      const remaining =
        order.status === 'cancelled'
          ? 0
          : Number(order.remainingTotal ?? Math.max(total - paid, 0));
      sheet.addRow([
        formatDate(order.saleDate ?? order.createdAt),
        formatDate(order.createdAt),
        safeText(order.orderNumber ?? order.orderId ?? order._id),
        safeText(order.customerName ?? '-'),
        safeText(order.phoneNumber ?? ''),
        order.orderType === 'QUICK_SALE' ? 'ขายด่วน' : 'งานปกติ',
        safeText(
          (order.cart ?? [])
            .map(
              (item) =>
                `${item.name ?? item.category ?? '-'} x${item.qty ?? 0}`,
            )
            .join(', '),
        ),
        order.payment === 'promptpay' ? 'PromptPay' : 'เงินสด',
        order.status,
        total,
        paid,
        remaining,
      ]);
    }
    sheet.columns = [14, 14, 18, 24, 16, 14, 40, 16, 18, 14, 14, 14].map(
      (width) => ({ width }),
    );
    sheet.getColumn(5).numFmt = '@';
    for (const index of [10, 11, 12])
      sheet.getColumn(index).numFmt = '#,##0.00';
    sheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: 'top', wrapText: true };
      if (rowNumber > 5 && rowNumber % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF4F7FB' },
        };
      }
    });
    sheet.autoFilter = { from: 'A5', to: 'L5' };
    const data = await workbook.xlsx.writeBuffer();
    return Buffer.from(data);
  }

  private buildPdf(
    orders: ReportOrder[],
    summary: OrderReportSummary,
    saleMonth?: string,
  ): Promise<Buffer> {
    const fontDirectory = this.resolveFontDirectory();
    return new Promise((resolve, reject) => {
      const document = new PDFDocument({
        size: 'A4',
        layout: 'portrait',
        margin: 45,
        bufferPages: true,
        info: {
          Title: `Glossy POS Sales Statement ${saleMonth ?? 'all'}`,
          Author: 'Glossy POS',
        },
      });
      const chunks: Buffer[] = [];
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));
      const thaiFont = join(fontDirectory, 'NotoSansThai-Variable.ttf');
      document.registerFont('Thai', thaiFont);
      document.registerFont('ThaiBold', thaiFont);

      const pageWidth = document.page.width;
      const pageHeight = document.page.height;
      const left = document.page.margins.left;
      const contentWidth = pageWidth - left - document.page.margins.right;
      const footerTop = pageHeight - 62;
      const navy = '#16354D';
      const text = '#172033';
      const muted = '#64748B';
      const border = '#D9E2EA';
      const tableHeaderHeight = 24;
      const columns = [
        { label: 'วันที่ / เวลา', width: 67 },
        { label: 'เลขที่งาน', width: 91 },
        { label: 'รายการ', width: 177 },
        { label: 'ลูกค้า', width: 100 },
        { label: 'ยอดรวม', width: contentWidth - 435 },
      ];
      const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
      const reportDate = new Date();
      const periodLabelText = saleMonth
        ? periodLabel('month', monthRange(saleMonth))
        : 'ทั้งหมด';
      const fullDate = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'Asia/Bangkok',
      }).format(reportDate);
      const compactDate = (value?: Date): string => {
        if (!value) return '-';
        return new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
          day: '2-digit',
          month: '2-digit',
          year: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
          timeZone: 'Asia/Bangkok',
        }).format(value);
      };
      const drawDocumentHeader = () => {
        document
          .fillColor(navy)
          .font('ThaiBold')
          .fontSize(15)
          .text('GLOSSY POS', left, 45);
        document
          .fillColor(text)
          .font('ThaiBold')
          .fontSize(13)
          .text('รายงานสรุปรายการขาย', left, 69);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(8)
          .text('SALES STATEMENT', left, 88);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(8)
          .text(`รอบรายการ: ${periodLabelText}`, pageWidth - 220, 51, {
            width: 175,
            align: 'right',
          });
        document.text(`วันที่ออกรายงาน: ${fullDate}`, pageWidth - 220, 67, {
          width: 175,
          align: 'right',
        });
        document.text('สกุลเงิน: THB', pageWidth - 220, 83, {
          width: 175,
          align: 'right',
        });
        document
          .moveTo(left, 108)
          .lineTo(pageWidth - left, 108)
          .lineWidth(0.8)
          .stroke(border);
        document
          .fillColor(text)
          .font('ThaiBold')
          .fontSize(9.5)
          .text('สรุปรายงาน', left, 124);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(8)
          .text('จำนวนรายการ', left, 143);
        document
          .fillColor(text)
          .font('ThaiBold')
          .fontSize(10)
          .text(`${summary.orders} รายการ`, left + 75, 143);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(8)
          .text('ยอดขายรวม', left + 190, 143);
        document
          .fillColor(text)
          .font('ThaiBold')
          .fontSize(10)
          .text(formatPdfMoney(summary.sales), left + 255, 143);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(8)
          .text('ยอดรับชำระ', left + 365, 143);
        document
          .fillColor(text)
          .font('ThaiBold')
          .fontSize(10)
          .text(formatPdfMoney(summary.collections), left + 430, 143, {
            width: contentWidth - 430,
            align: 'right',
          });
        document
          .moveTo(left, 162)
          .lineTo(pageWidth - left, 162)
          .lineWidth(0.8)
          .stroke(border);
      };
      const drawTableHeader = (top: number) => {
        document.rect(left, top, tableWidth, tableHeaderHeight).fill(navy);
        let x = left;
        document.fillColor('#FFFFFF').font('ThaiBold').fontSize(7.5);
        for (const column of columns) {
          document.text(column.label, x + 5, top + 7, {
            width: column.width - 10,
            align: column.label === 'ยอดรวม' ? 'right' : 'left',
            lineBreak: false,
          });
          x += column.width;
        }
        return top + tableHeaderHeight;
      };
      drawDocumentHeader();
      let y = drawTableHeader(178);
      const startContinuationPage = () => {
        document.addPage();
        y = 45;
        document
          .fillColor(navy)
          .font('ThaiBold')
          .fontSize(10)
          .text('รายงานสรุปรายการขาย / SALES STATEMENT', left, y);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(8)
          .text(`รอบรายการ: ${periodLabelText}`, pageWidth - 220, y + 1, {
            width: 175,
            align: 'right',
          });
        y += 26;
        y = drawTableHeader(y);
      };
      orders.forEach((order, index) => {
        const total = Number(order.grandTotal ?? order.total ?? 0);
        const itemLines = (order.cart ?? []).map(
          (item) =>
            `${String(item.name ?? item.category ?? '-')} x${Number(item.qty ?? 0)}`,
        );
        const itemText = itemLines.join('\n') || '-';
        document.font('Thai').fontSize(7.5);
        const itemHeight = document.heightOfString(itemText, {
          width: columns[2].width - 10,
          lineGap: 1,
        });
        const customerHeight = document.heightOfString(
          String(order.customerName ?? '-'),
          { width: columns[3].width - 10, lineGap: 1 },
        );
        const rowHeight = Math.max(
          27,
          Math.ceil(Math.max(itemHeight, customerHeight) + 12),
        );
        if (y + rowHeight > footerTop) startContinuationPage();
        document
          .rect(left, y, tableWidth, rowHeight)
          .fill(index % 2 ? '#F7F9FB' : '#FFFFFF');
        document
          .moveTo(left, y + rowHeight)
          .lineTo(left + tableWidth, y + rowHeight)
          .lineWidth(0.45)
          .stroke(border);
        const values = [
          compactDate(order.saleDate ?? order.createdAt),
          String(order.orderNumber ?? order.orderId ?? order._id),
          itemText,
          String(order.customerName ?? '-'),
          formatPdfMoney(total),
        ];
        let x = left;
        values.forEach((value, columnIndex) => {
          document
            .fillColor(text)
            .font('Thai')
            .fontSize(7.5)
            .text(value, x + 5, y + 6, {
              width: columns[columnIndex].width - 10,
              height: rowHeight - 8,
              lineGap: 1,
              align: columnIndex === values.length - 1 ? 'right' : 'left',
            });
          x += columns[columnIndex].width;
        });
        y += rowHeight;
      });
      if (orders.length === 0) {
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(9)
          .text('ไม่พบรายการขายในช่วงเวลาที่เลือก', left, y + 18, {
            width: tableWidth,
            align: 'center',
          });
        y += 55;
      }
      const summaryHeight = 104;
      if (y + summaryHeight > footerTop) startContinuationPage();
      document
        .moveTo(left, y + 12)
        .lineTo(pageWidth - left, y + 12)
        .lineWidth(0.8)
        .stroke(border);
      document
        .fillColor(text)
        .font('ThaiBold')
        .fontSize(9.5)
        .text('สรุปยอดท้ายรายงาน', left, y + 27);
      document
        .fillColor(muted)
        .font('Thai')
        .fontSize(8)
        .text(`จำนวนรายการทั้งหมด: ${summary.orders} รายการ`, left, y + 48);
      document
        .fillColor(muted)
        .font('Thai')
        .fontSize(8)
        .text('ยอดขายรวม', left + 295, y + 43, { width: 90, align: 'right' });
      document
        .fillColor(text)
        .font('ThaiBold')
        .fontSize(8.5)
        .text(formatPdfMoney(summary.sales), left + 390, y + 43, {
          width: contentWidth - 390,
          align: 'right',
        });
      document
        .fillColor(muted)
        .font('Thai')
        .fontSize(8)
        .text('ยอดรับชำระ', left + 295, y + 59, { width: 90, align: 'right' });
      document.text(formatPdfMoney(summary.collections), left + 390, y + 59, {
        width: contentWidth - 390,
        align: 'right',
      });
      document.text('ยอดค้างชำระ', left + 295, y + 75, {
        width: 90,
        align: 'right',
      });
      document.text(formatPdfMoney(summary.outstanding), left + 390, y + 75, {
        width: contentWidth - 390,
        align: 'right',
      });
      const pageRange = document.bufferedPageRange();
      for (let pageIndex = 0; pageIndex < pageRange.count; pageIndex += 1) {
        document.switchToPage(pageRange.start + pageIndex);
        const pageBottomMargin = document.page.margins.bottom;
        document.page.margins.bottom = 0;
        document
          .moveTo(left, footerTop)
          .lineTo(pageWidth - left, footerTop)
          .lineWidth(0.6)
          .stroke(border);
        document
          .fillColor(muted)
          .font('Thai')
          .fontSize(7)
          .text('Glossy POS • Sales Statement', left, footerTop + 10, {
            lineBreak: false,
          });
        document.text(
          `หน้า ${pageIndex + 1} / ${pageRange.count}`,
          pageWidth - 155,
          footerTop + 10,
          { width: 110, align: 'right', lineBreak: false },
        );
        document.page.margins.bottom = pageBottomMargin;
      }
      document.end();
    });
  }

  private resolveFontDirectory(): string {
    const candidates = [
      join(__dirname, '..', 'assets', 'fonts'),
      join(process.cwd(), 'src', 'assets', 'fonts'),
      join(process.cwd(), 'dist', 'assets', 'fonts'),
    ];
    const directory = candidates.find((candidate) =>
      existsSync(join(candidate, 'NotoSansThai-Variable.ttf')),
    );
    if (!directory) throw new Error('Thai PDF font assets are missing.');
    return directory;
  }
}
