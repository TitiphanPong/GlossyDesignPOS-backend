import { DashboardService } from './dashboard.service';

function findChain(result: unknown[]) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe('DashboardService', () => {
  it('returns an all-time operational snapshot based on effective workflow state', async () => {
    const pipelines: unknown[] = [];
    const aggregateResults = [
      [{ _id: 'paid', count: 5 }],
      [
        { _id: 'pending', count: 2, unclassified: 1 },
        { _id: 'producing', count: 3 },
        { _id: 'ready_for_pickup', count: 1 },
      ],
      [
        { _id: 'today', total: 150.25, orders: 1 },
        { _id: '1-7', total: 200, orders: 2 },
      ],
    ];
    const orderModel = {
      aggregate: jest.fn((pipeline: unknown) => {
        pipelines.push(pipeline);
        return Promise.resolve(aggregateResults[pipelines.length - 1]);
      }),
      find: jest.fn().mockReturnValue(findChain([])),
    };
    const uploadModel = {
      aggregate: jest
        .fn()
        .mockResolvedValue([{ _id: 'pending', uploads: 1, files: 3 }]),
      countDocuments: jest
        .fn()
        .mockResolvedValueOnce(7)
        .mockResolvedValueOnce(3),
      find: jest.fn().mockReturnValue(findChain([])),
    };
    const stockItemModel = {
      countDocuments: jest.fn().mockResolvedValue(4),
    };
    let capturedProductionPipeline: unknown;
    const productionJobModel = {
      aggregate: jest.fn((pipeline: unknown) => {
        capturedProductionPipeline = pipeline;
        return Promise.resolve([
          {
            dueToday: [{ count: 4 }],
            overdue: [{ count: 2 }],
            rush: [{ count: 3 }],
            urgent: [{ count: 6 }],
          },
        ]);
      }),
    };
    const orderReporting = {
      getDashboardMetrics: jest.fn().mockResolvedValue({
        period: {
          mode: 'today',
          from: '2026-08-27T17:00:00.000Z',
          toExclusive: '2026-08-28T17:00:00.000Z',
          label: 'วันนี้',
        },
        periodSummary: {
          sales: 1000,
          collections: 500,
          orders: 2,
          customers: 2,
          previousSales: 0,
          previousOrders: 0,
        },
        paymentSummary: {
          received: 500,
          cash: 500,
          transfer: 0,
          fullPayment: 500,
          deposits: 0,
          oldOutstandingPaid: 0,
        },
        salesTrend: [],
        topProducts: [],
        quickSeller: { orders: 0, revenue: 0, items: [] },
      }),
    };
    const service = new DashboardService(
      orderModel as never,
      uploadModel as never,
      stockItemModel as never,
      productionJobModel as never,
      orderReporting as never,
    );

    const summary = await service.getSummary({ period: 'today' });

    expect(summary.operations).toEqual({
      workflow: { pending: 2, producing: 3, ready_for_pickup: 1 },
      production: { dueToday: 4, overdue: 2, rush: 3 },
      outstanding: { orders: 3, amount: 350.25 },
      filesWaiting: 7,
      lowStock: 4,
      unclassifiedWorkflow: 1,
    });
    expect(summary.uploads.waitingReview).toBe(7);
    expect(summary.uploads.unlinked).toBe(3);
    expect(summary.today.urgentJobs).toBe(6);
    expect(summary.capabilities).toEqual({
      dueDates: true,
      urgentFlag: true,
      uploadOrderLink: true,
    });
    expect(productionJobModel.aggregate).toHaveBeenCalledTimes(1);
    const productionPipeline = JSON.stringify(capturedProductionPipeline);
    expect(productionPipeline).toContain('ready');
    expect(productionPipeline).toContain('delivered');
    expect(productionPipeline).toContain('dueToday');
    expect(productionPipeline).toContain('overdue');
    expect(productionPipeline).toContain('rush');
    expect(uploadModel.countDocuments).toHaveBeenCalledWith({
      status: 'pending',
    });
    expect(stockItemModel.countDocuments).toHaveBeenCalledWith({
      active: true,
      $expr: { $lte: ['$onHand', '$minimumLevel'] },
    });

    const serializedPipeline = JSON.stringify(pipelines[1]);
    expect(serializedPipeline).toContain('workflowStatus');
    expect(serializedPipeline).toContain('statusHistory');
  });
});
