import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import { Order, OrderDocument, ORDER_STATUSES } from '../orders/orders.schema';
import { Upload, UploadDocument } from '../uploads/schemas/upload.schema';
import { DashboardSummaryQueryDto } from './dto/dashboard-summary-query.dto';
import { OrderReportingService } from '../orders/order-reporting.service';

type StatusRow = { _id: string; count: number };
type AgingRow = { _id: string; total: number };

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
