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
      ];
    }
    if (query.status) filter.status = query.status;
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
      filename: `orders-${filenamePeriod}.pdf`,
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
        layout: 'landscape',
        margin: 32,
        info: { Title: `Orders ${saleMonth ?? 'all'}`, Author: 'Glossy POS' },
      });
      const chunks: Buffer[] = [];
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));
      const thaiFont = join(fontDirectory, 'NotoSansThai-Variable.ttf');
      document.registerFont('Thai', thaiFont);
      document.registerFont('ThaiBold', thaiFont);

      document.rect(0, 0, document.page.width, 88).fill('#1E5EFF');
      document
        .fillColor('#FFFFFF')
        .font('ThaiBold')
        .fontSize(21)
        .text('รายงานยอดขายและรายการงาน', 32, 26);
      document
        .font('Thai')
        .fontSize(10)
        .text(
          `ช่วงเวลา: ${saleMonth ?? 'ทั้งหมด'} | สร้างเมื่อ ${formatDate(new Date())}`,
          32,
          58,
        );
      document.fillColor('#102A43');
      const cards = [
        ['ยอดขาย', formatMoney(summary.sales)],
        ['ยอดรับ', formatMoney(summary.collections)],
        ['ยอดค้าง', formatMoney(summary.outstanding)],
        ['งานทั้งหมด', String(summary.orders)],
        ['ยกเลิก', String(summary.cancelledOrders)],
      ];
      cards.forEach(([label, value], index) => {
        const x = 32 + index * 153;
        document.roundedRect(x, 104, 137, 54, 6).fill('#F4F7FB');
        document
          .fillColor('#64748B')
          .font('Thai')
          .fontSize(9)
          .text(label, x + 10, 114);
        document
          .fillColor('#102A43')
          .font('ThaiBold')
          .fontSize(14)
          .text(value, x + 10, 132, { width: 117 });
      });

      const columns = [
        { label: 'วันที่ขาย', width: 88 },
        { label: 'เลขที่งาน', width: 105 },
        { label: 'ลูกค้า', width: 170 },
        { label: 'สถานะ', width: 105 },
        { label: 'ยอดรวม', width: 95 },
        { label: 'ยอดรับ', width: 95 },
        { label: 'ยอดค้าง', width: 95 },
      ];
      const left = 32;
      const tableWidth = columns.reduce((sum, column) => sum + column.width, 0);
      let y = 178;
      let pageNumber = 1;
      const drawFooter = () => {
        const bottomMargin = document.page.margins.bottom;
        document.page.margins.bottom = 0;
        document
          .fillColor('#94A3B8')
          .font('Thai')
          .fontSize(8)
          .text(`หน้า ${pageNumber}`, 32, document.page.height - 24, {
            width: document.page.width - 64,
            align: 'right',
            lineBreak: false,
          });
        document.page.margins.bottom = bottomMargin;
      };
      const drawHeader = () => {
        document.rect(left, y, tableWidth, 26).fill('#2A4365');
        let x = left;
        document.fillColor('#FFFFFF').font('ThaiBold').fontSize(9);
        for (const column of columns) {
          document.text(column.label, x + 5, y + 7, {
            width: column.width - 10,
            align: column.label.startsWith('ยอด') ? 'right' : 'left',
          });
          x += column.width;
        }
        y += 26;
      };
      drawHeader();
      orders.forEach((order, index) => {
        const total = Number(order.grandTotal ?? order.total ?? 0);
        const paid = Number(order.paidAmount ?? order.depositTotal ?? 0);
        const remaining =
          order.status === 'cancelled'
            ? 0
            : Number(order.remainingTotal ?? Math.max(total - paid, 0));
        const values = [
          formatDate(order.saleDate ?? order.createdAt),
          String(order.orderNumber ?? order.orderId ?? order._id),
          String(order.customerName ?? '-'),
          String(order.status),
          formatMoney(total),
          formatMoney(paid),
          formatMoney(remaining),
        ];
        const rowHeight = 28;
        if (y + rowHeight > document.page.height - 45) {
          drawFooter();
          document.addPage();
          pageNumber += 1;
          y = 32;
          drawHeader();
        }
        document
          .rect(left, y, tableWidth, rowHeight)
          .fill(index % 2 ? '#F8FAFC' : '#FFFFFF');
        let x = left;
        document.fillColor('#334155').font('Thai').fontSize(8.5);
        values.forEach((value, columnIndex) => {
          document.text(value, x + 5, y + 7, {
            width: columns[columnIndex].width - 10,
            height: rowHeight - 10,
            ellipsis: true,
            align: columnIndex >= 4 ? 'right' : 'left',
          });
          x += columns[columnIndex].width;
        });
        y += rowHeight;
      });
      if (orders.length === 0) {
        document
          .fillColor('#64748B')
          .font('Thai')
          .fontSize(11)
          .text('ไม่พบรายการตามตัวกรอง', left, y + 18, {
            width: tableWidth,
            align: 'center',
          });
      }
      drawFooter();
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
