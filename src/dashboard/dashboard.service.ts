import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { Order, OrderDocument, ORDER_STATUSES } from '../orders/orders.schema';
import { Upload, UploadDocument } from '../uploads/schemas/upload.schema';
import { DashboardSummaryQueryDto } from './dto/dashboard-summary-query.dto';
import { OrderReportingService } from '../orders/order-reporting.service';

type TotalRow = {
  _id: null;
  total: number;
  count: number;
  customers?: string[];
};
type StatusRow = { _id: string; count: number };
type TrendRow = { _id: string; revenue: number; orders: number };
type AgingRow = { _id: string; total: number };
type ReceivedRow = {
  received: number;
  cash: number;
  transfer: number;
  fullPayment: number;
  deposits: number;
  oldOutstandingPaid: number;
};
type QuickSaleRow = {
  orders: number;
  revenue: number;
  items: Array<{ name: string; quantity: number; revenue: number }>;
};

const DAY_MS = 86_400_000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const ACTIVE_STATUSES = [
  'pending',
  'producing',
  'awaiting_payment',
  'ready_for_pickup',
  'partial',
] as const;

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

@Injectable()
export class DashboardService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Upload.name)
    private readonly uploadModel: Model<UploadDocument>,
    private readonly orderReporting: OrderReportingService,
  ) {}

  async getSummary(query: DashboardSummaryQueryDto = {}) {
    const todayStart = bangkokDayStart();
    const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
    const [metrics, statusRows, tasks, agingRows, uploadRows, recentUploads] =
      await Promise.all([
        this.orderReporting.getDashboardMetrics(query),
        this.orderModel.aggregate<StatusRow>([
          { $match: { status: { $in: [...ORDER_STATUSES] } } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]),
        this.orderModel
          .find({ status: { $in: [...ACTIVE_STATUSES] } })
          .sort({ updatedAt: -1 })
          .limit(8)
          .select(
            'orderId orderNumber customerName cart status remainingTotal createdAt updatedAt',
          )
          .lean(),
        this.orderModel.aggregate<AgingRow>(this.agingPipeline(todayStart)),
        this.uploadModel.aggregate<{
          _id: string;
          uploads: number;
          files: number;
        }>([
          { $match: { createdAt: { $gte: todayStart, $lt: tomorrowStart } } },
          {
            $group: {
              _id: '$status',
              uploads: { $sum: 1 },
              files: { $sum: { $size: { $ifNull: ['$files', []] } } },
            },
          },
        ]),
        this.uploadModel
          .find({ createdAt: { $gte: todayStart, $lt: tomorrowStart } })
          .sort({ createdAt: -1 })
          .limit(5)
          .select('uploadId customerName status files createdAt')
          .lean(),
      ]);

    const status = Object.fromEntries(
      ORDER_STATUSES.map((key) => [
        key,
        statusRows.find((row) => row._id === key)?.count ?? 0,
      ]),
    );
    const outstanding = agingRows.reduce((sum, row) => sum + row.total, 0);

    return {
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Bangkok',
      period: metrics.period,
      periodSummary: metrics.periodSummary,
      today: {
        sales: metrics.periodSummary.sales,
        received: metrics.periodSummary.collections,
        orders: metrics.periodSummary.orders,
        customers: metrics.periodSummary.customers,
        outstanding,
        urgentJobs: 0,
        yesterdaySales: metrics.periodSummary.previousSales,
        yesterdayOrders: metrics.periodSummary.previousOrders,
      },
      paymentSummary: metrics.paymentSummary,
      orderStatus: status,
      salesTrend: metrics.salesTrend,
      topProducts: metrics.topProducts,
      quickSeller: metrics.quickSeller,
      uploads: {
        newFiles: uploadRows.reduce((sum, row) => sum + row.files, 0),
        newUploads: uploadRows.reduce((sum, row) => sum + row.uploads, 0),
        waitingReview: uploadRows
          .filter((row) => row._id === 'pending')
          .reduce((sum, row) => sum + row.uploads, 0),
        unlinked: 0,
      },
      outstandingAging: {
        total: outstanding,
        today: agingRows.find((row) => row._id === 'today')?.total ?? 0,
        days1To7: agingRows.find((row) => row._id === '1-7')?.total ?? 0,
        days8To30: agingRows.find((row) => row._id === '8-30')?.total ?? 0,
        over30Days: agingRows.find((row) => row._id === 'over-30')?.total ?? 0,
      },
      tasks: tasks.map((order) => ({
        id: String(order._id),
        orderNumber: order.orderNumber ?? order.orderId ?? String(order._id),
        customerName: order.customerName || '-',
        job: order.cart?.[0]?.name || order.cart?.[0]?.category || '-',
        status: order.status,
        remainingPayment: order.remainingTotal ?? 0,
        updatedAt: (order as { updatedAt?: Date }).updatedAt,
      })),
      recentActivity: [
        ...tasks.slice(0, 5).map((order) => ({
          type: 'order',
          id: String(order._id),
          title: `Order ${order.orderNumber ?? order.orderId ?? ''}`,
          detail: order.status,
          at: (order as { updatedAt?: Date }).updatedAt,
        })),
        ...recentUploads.map((upload) => ({
          type: 'upload',
          id: upload.uploadId,
          title: upload.customerName || 'Customer upload',
          detail: `${upload.files?.length ?? 0} file(s)`,
          at: (upload as { createdAt?: Date }).createdAt,
        })),
      ]
        .filter((item) => item.at)
        .sort(
          (a, b) =>
            new Date(b.at as Date).getTime() - new Date(a.at as Date).getTime(),
        )
        .slice(0, 8),
      capabilities: {
        dueDates: false,
        urgentFlag: false,
        uploadOrderLink: false,
      },
    };
  }

  private async getLegacySummary() {
    const todayStart = bangkokDayStart();
    const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
    const yesterdayStart = new Date(todayStart.getTime() - DAY_MS);
    const trendStart = new Date(todayStart.getTime() - 6 * DAY_MS);

    const [
      todayRows,
      yesterdayRows,
      receivedRows,
      statusRows,
      trendRows,
      topProducts,
      quickRows,
      tasks,
      agingRows,
      uploadRows,
      recentUploads,
    ] = await Promise.all([
      this.orderModel.aggregate<TotalRow>([
        {
          $match: {
            $expr: {
              $and: [
                { $gte: [saleDateExpression(), todayStart] },
                { $lt: [saleDateExpression(), tomorrowStart] },
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
      ]),
      this.orderModel.aggregate<TotalRow>([
        {
          $match: {
            $expr: {
              $and: [
                { $gte: [saleDateExpression(), yesterdayStart] },
                { $lt: [saleDateExpression(), todayStart] },
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
          },
        },
      ]),
      this.orderModel.aggregate<ReceivedRow>(
        this.receivedPipeline(todayStart, tomorrowStart),
      ),
      this.orderModel.aggregate<StatusRow>([
        { $match: { status: { $in: [...ORDER_STATUSES] } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      this.orderModel.aggregate<TrendRow>([
        {
          $match: {
            $expr: {
              $and: [
                { $gte: [saleDateExpression(), trendStart] },
                { $lt: [saleDateExpression(), tomorrowStart] },
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
      }>(
        this.topProductsPipeline(todayStart, tomorrowStart, {
          $ne: 'QUICK_SALE',
        }),
      ),
      this.orderModel.aggregate<QuickSaleRow>(
        this.quickSalePipeline(todayStart, tomorrowStart),
      ),
      this.orderModel
        .find({ status: { $in: [...ACTIVE_STATUSES] } })
        .sort({ updatedAt: -1 })
        .limit(8)
        .select(
          'orderId orderNumber customerName cart status remainingTotal createdAt updatedAt',
        )
        .lean(),
      this.orderModel.aggregate<AgingRow>(this.agingPipeline(todayStart)),
      this.uploadModel.aggregate<{
        _id: string;
        uploads: number;
        files: number;
      }>([
        { $match: { createdAt: { $gte: todayStart, $lt: tomorrowStart } } },
        {
          $group: {
            _id: '$status',
            uploads: { $sum: 1 },
            files: { $sum: { $size: { $ifNull: ['$files', []] } } },
          },
        },
      ]),
      this.uploadModel
        .find({ createdAt: { $gte: todayStart, $lt: tomorrowStart } })
        .sort({ createdAt: -1 })
        .limit(5)
        .select('uploadId customerName status files createdAt')
        .lean(),
    ]);

    const today = todayRows[0];
    const yesterday = yesterdayRows[0];
    const received = receivedRows[0] ?? {
      received: 0,
      cash: 0,
      transfer: 0,
      fullPayment: 0,
      deposits: 0,
      oldOutstandingPaid: 0,
    };
    const status = Object.fromEntries(
      ORDER_STATUSES.map((key) => [
        key,
        statusRows.find((row) => row._id === key)?.count ?? 0,
      ]),
    );
    const trendMap = new Map(trendRows.map((row) => [row._id, row]));
    const salesTrend = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(trendStart.getTime() + index * DAY_MS);
      const key = new Date(date.getTime() + BANGKOK_OFFSET_MS)
        .toISOString()
        .slice(0, 10);
      const row = trendMap.get(key);
      return {
        date: key,
        revenue: row?.revenue ?? 0,
        orders: row?.orders ?? 0,
      };
    });
    const outstanding = agingRows.reduce((sum, row) => sum + row.total, 0);

    return {
      generatedAt: new Date().toISOString(),
      timezone: 'Asia/Bangkok',
      today: {
        sales: today?.total ?? 0,
        received: received.received,
        orders: today?.count ?? 0,
        customers: today?.customers?.filter(Boolean).length ?? 0,
        outstanding,
        urgentJobs: 0,
        yesterdaySales: yesterday?.total ?? 0,
        yesterdayOrders: yesterday?.count ?? 0,
      },
      paymentSummary: received,
      orderStatus: status,
      salesTrend,
      topProducts,
      quickSeller: quickRows[0] ?? { orders: 0, revenue: 0, items: [] },
      uploads: {
        newFiles: uploadRows.reduce((sum, row) => sum + row.files, 0),
        newUploads: uploadRows.reduce((sum, row) => sum + row.uploads, 0),
        waitingReview: uploadRows
          .filter((row) => row._id === 'pending')
          .reduce((sum, row) => sum + row.uploads, 0),
        unlinked: 0,
      },
      outstandingAging: {
        total: outstanding,
        today: agingRows.find((row) => row._id === 'today')?.total ?? 0,
        days1To7: agingRows.find((row) => row._id === '1-7')?.total ?? 0,
        days8To30: agingRows.find((row) => row._id === '8-30')?.total ?? 0,
        over30Days: agingRows.find((row) => row._id === 'over-30')?.total ?? 0,
      },
      tasks: tasks.map((order) => ({
        id: String(order._id),
        orderNumber: order.orderNumber ?? order.orderId ?? String(order._id),
        customerName: order.customerName || '-',
        job: order.cart?.[0]?.name || order.cart?.[0]?.category || '-',
        status: order.status,
        remainingPayment: order.remainingTotal ?? 0,
        updatedAt: (order as { updatedAt?: Date }).updatedAt,
      })),
      recentActivity: [
        ...tasks.slice(0, 5).map((order) => ({
          type: 'order',
          id: String(order._id),
          title: `Order ${order.orderNumber ?? order.orderId ?? ''}`,
          detail: order.status,
          at: (order as { updatedAt?: Date }).updatedAt,
        })),
        ...recentUploads.map((upload) => ({
          type: 'upload',
          id: upload.uploadId,
          title: upload.customerName || 'Customer upload',
          detail: `${upload.files?.length ?? 0} file(s)`,
          at: (upload as { createdAt?: Date }).createdAt,
        })),
      ]
        .filter((item) => item.at)
        .sort(
          (a, b) =>
            new Date(b.at as Date).getTime() - new Date(a.at as Date).getTime(),
        )
        .slice(0, 8),
      capabilities: {
        dueDates: false,
        urgentFlag: false,
        uploadOrderLink: false,
      },
    };
  }

  private receivedPipeline(start: Date, end: Date): PipelineStage[] {
    return [
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
          initial: {
            $cond: [
              {
                $and: [
                  { $gte: ['$createdAt', start] },
                  { $lt: ['$createdAt', end] },
                ],
              },
              '$initialPaid',
              0,
            ],
          },
          payment: 1,
          total: 1,
          createdAt: 1,
          todayPayments: {
            $filter: {
              input: '$payments',
              as: 'p',
              cond: {
                $and: [
                  { $gte: ['$$p.paidAt', start] },
                  { $lt: ['$$p.paidAt', end] },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          initial: 1,
          payment: 1,
          total: 1,
          createdAt: 1,
          paymentReceived: {
            $sum: {
              $map: { input: '$todayPayments', as: 'p', in: '$$p.amount' },
            },
          },
          paymentCash: {
            $sum: {
              $map: {
                input: '$todayPayments',
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
                input: '$todayPayments',
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
      {
        $project: {
          _id: 0,
          received: 1,
          cash: 1,
          transfer: 1,
          fullPayment: 1,
          deposits: 1,
          oldOutstandingPaid: 1,
        },
      },
    ];
  }

  private topProductsPipeline(
    start: Date,
    end: Date,
    orderType: Record<string, unknown>,
  ): PipelineStage[] {
    return [
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [saleDateExpression(), start] },
              { $lt: [saleDateExpression(), end] },
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
            $ifNull: [
              '$cart.name',
              { $ifNull: ['$cart.category', 'Unspecified'] },
            ],
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

  private quickSalePipeline(start: Date, end: Date): PipelineStage[] {
    return [
      {
        $match: {
          $expr: {
            $and: [
              { $gte: [saleDateExpression(), start] },
              { $lt: [saleDateExpression(), end] },
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

  private agingPipeline(todayStart: Date): PipelineStage[] {
    return [
      { $match: { remainingTotal: { $gt: 0 }, status: { $ne: 'cancelled' } } },
      {
        $project: {
          remainingTotal: 1,
          ageDays: {
            $floor: {
              $divide: [{ $subtract: [todayStart, '$createdAt'] }, DAY_MS],
            },
          },
        },
      },
      {
        $group: {
          _id: {
            $switch: {
              branches: [
                { case: { $lte: ['$ageDays', 0] }, then: 'today' },
                { case: { $lte: ['$ageDays', 7] }, then: '1-7' },
                { case: { $lte: ['$ageDays', 30] }, then: '8-30' },
              ],
              default: 'over-30',
            },
          },
          total: { $sum: '$remainingTotal' },
        },
      },
    ];
  }
}
