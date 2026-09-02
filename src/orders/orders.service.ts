import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import { Connection, isValidObjectId, Model, Types } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { OrderResponseDto } from './dto/order-response.dto';
import {
  PublicTrackingMilestone,
  PublicTrackingResponseDto,
} from './dto/tracking-response.dto';
import { UpdateOrderCustomerDto } from './dto/update-order-customer.dto';
import {
  ExportOrdersQueryDto,
  ListOrdersQueryDto,
} from './dto/list-orders-query.dto';
import {
  ORDER_WORKFLOW_STATUSES,
  Order,
  OrderDocument,
  OrderStatus,
  OrderWorkflowStatus,
  PaymentMethod,
} from './orders.schema';
import { OrdersSseService } from './orders.sse.service';
import { CreateOrderDto } from './dto/order.dto';
import {
  calculateOrderMoney,
  fromMinorUnits,
  toMinorUnits,
} from './order-money';
import { OrderPricingService } from './order-pricing.service';
import { normalizeBackdatedSale } from './order-backdate';
import { UserRole } from '../auth/auth.constants';
import { AuthenticatedUser } from '../auth/auth.types';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import {
  ProductionJob,
  ProductionJobDocument,
  ProductionJobStage,
} from '../production/schemas/production-job.schema';
import {
  OrderReportingService,
  OrderReportSummary,
} from './order-reporting.service';

type OrderPlainObject = Order & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  saleDate?: Date;
};
type CreateOrderIdentity = {
  clientDraftId?: string;
  idempotencyKey?: string;
};
type ProductionTrackingJob = {
  stage: ProductionJobStage;
  stageHistory: Array<{
    stage: ProductionJobStage;
    changedAt: Date;
  }>;
  updatedAt?: Date;
};
type ProductionTrackingProjection = {
  currentMilestone: Extract<
    PublicTrackingMilestone,
    'received' | 'in_progress' | 'ready'
  >;
  inProgressAt?: Date;
  readyAt?: Date;
};
type ListOrdersResponse = {
  data: OrderResponseDto[];
  page: number;
  limit: number;
  total: number;
  summary: OrderReportSummary;
};

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

const PUBLIC_MILESTONE_BY_STATUS: Partial<
  Record<OrderStatus, PublicTrackingMilestone>
> = {
  pending: 'received',
  producing: 'in_progress',
  ready_for_pickup: 'ready',
  delivered: 'completed',
  cancelled: 'cancelled',
};

const NEXT_PRODUCTION_WORKFLOW_STATUS: Partial<
  Record<OrderWorkflowStatus, OrderWorkflowStatus>
> = {
  pending: 'producing',
  producing: 'ready_for_pickup',
  ready_for_pickup: 'delivered',
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly runningNumberService: RunningNumberService,
    private readonly ordersSse: OrdersSseService,
    private readonly orderPricing: OrderPricingService,
    @Optional() private readonly orderReporting: OrderReportingService,
    private readonly notificationsService: NotificationsService,
    @InjectConnection() private readonly mongoConnection: Connection,
    @Optional()
    @InjectModel(Customer.name)
    private readonly customerModel?: Model<CustomerDocument>,
    @Optional()
    @InjectModel(ProductionJob.name)
    private readonly productionJobModel?: Model<ProductionJobDocument>,
  ) {}

  async create(
    orderDto: CreateOrderDto,
    idempotencyKey?: string,
    actor?: Pick<AuthenticatedUser, 'id' | 'role'> | null,
  ): Promise<OrderResponseDto> {
    const identity = this.normalizeCreateIdentity(orderDto, idempotencyKey);
    const commandFingerprint =
      identity.clientDraftId || identity.idempotencyKey
        ? this.buildCreateCommandFingerprint(orderDto, identity, actor?.id)
        : undefined;
    const existing = await this.findExistingOrderForCreate(identity);
    if (existing) {
      this.assertCreateReplayMatches(existing, commandFingerprint);
      return this.toOrderResponse(existing);
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.persistNewOrder(
          orderDto,
          identity,
          actor?.role,
          actor?.id,
          commandFingerprint,
        );
      } catch (error) {
        const recovered = await this.recoverFromCreateError(
          error,
          identity,
          commandFingerprint,
          attempt,
          maxAttempts,
        );
        if (recovered) {
          return recovered;
        }
      }
    }

    throw new InternalServerErrorException('Failed to create order.');
  }

  async findAll(query: ListOrdersQueryDto = {}): Promise<ListOrdersResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter = this.orderReporting.buildOrderFilter(query);
    const [plainOrders, total, summary] = await Promise.all([
      this.orderModel.aggregate<OrderPlainObject>([
        ...this.orderReporting.listPipeline(query),
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ]),
      this.orderModel.countDocuments(filter),
      this.orderReporting.getOrderSummary(query),
    ]);
    const orders = plainOrders.map((order) => this.orderModel.hydrate(order));

    return {
      data: orders.map((order) => this.toOrderResponse(order)),
      page,
      limit,
      total,
      summary,
    };
  }

  async findById(id: string): Promise<OrderResponseDto | null> {
    this.assertMongoObjectId(id, 'order id');
    const order = await this.orderModel.findById(id).exec();
    return order ? this.toOrderResponse(order) : null;
  }

  async findLatestActive(): Promise<OrderResponseDto | null> {
    const order = await this.orderModel
      .findOne({
        status: {
          $in: [
            'pending',
            'producing',
            'awaiting_payment',
            'ready_for_pickup',
            'paid',
          ],
        },
      })
      .sort({ updatedAt: -1 })
      .exec();
    return order ? this.toOrderResponse(order) : null;
  }

  async updateStatus(
    id: string,
    status: OrderStatus,
    statusNote?: string,
    actor?: Pick<AuthenticatedUser, 'id'> | null,
  ): Promise<OrderResponseDto | null> {
    this.assertWorkflowStatusWritable(status);
    this.assertMongoObjectId(id, 'order id');
    const workflowStatus = status as OrderWorkflowStatus;
    const transition = await this.transitionWorkflowStatus(
      id,
      workflowStatus,
      statusNote,
      actor?.id,
    );

    if (!transition) return null;

    const response = this.toOrderResponse(transition.order);
    if (transition.changed) {
      this.emitForStatus(response, workflowStatus);
    }

    return response;
  }

  async updateOrder(
    id: string,
    updateDto: UpdateOrderCustomerDto,
    actor?: Pick<AuthenticatedUser, 'id'> | null,
  ): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');
    const { status, statusNote, ...customerFields } = updateDto;
    const hasCustomerFields = Object.values(customerFields).some(
      (value) => value !== undefined,
    );

    if (status !== undefined) {
      this.assertWorkflowStatusWritable(status);
    }

    if (status !== undefined && !hasCustomerFields) {
      const updated = await this.updateStatus(id, status, statusNote, actor);
      if (!updated) {
        throw new NotFoundException(`Order not found for id "${id}".`);
      }
      return updated;
    }

    const update: Partial<Order> = hasCustomerFields
      ? this.buildCustomerInfoUpdate(customerFields)
      : {};

    if (hasCustomerFields) {
      update.orderType = 'NORMAL';
    }

    if (!Object.keys(update).length) {
      throw new BadRequestException(
        'At least one order field must be provided.',
      );
    }

    if (status !== undefined) {
      const workflowStatus = status as OrderWorkflowStatus;
      const transition = await this.transitionWorkflowStatus(
        id,
        workflowStatus,
        statusNote,
        actor?.id,
        update,
      );
      if (!transition) {
        throw new NotFoundException(`Order not found for id "${id}".`);
      }

      const response = this.toOrderResponse(transition.order);
      if (transition.changed) {
        this.emitForStatus(response, workflowStatus);
      }
      return response;
    }

    const updated = await this.orderModel
      .findByIdAndUpdate(
        id,
        { $set: update },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }

    return this.toOrderResponse(updated);
  }

  async convertToTaxInvoice(id: string): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');

    const transactionResult = await this.mongoConnection.transaction(
      async (session) => {
        const existing = await this.orderModel
          .findById(id)
          .session(session)
          .exec();
        if (!existing) {
          throw new NotFoundException(`Order not found for id "${id}".`);
        }

        const invoiceIdentity = [
          existing.invoiceNumber,
          existing.bookNo,
          existing.invoiceSequence,
          existing.invoicePeriod,
        ];
        const hasAnyInvoiceIdentity = invoiceIdentity.some(Boolean);
        const hasCompleteInvoiceIdentity = invoiceIdentity.every(Boolean);
        if (hasAnyInvoiceIdentity && !hasCompleteInvoiceIdentity) {
          throw new ConflictException(
            'Tax invoice identity is incomplete. Reconciliation is required before conversion.',
          );
        }

        const storedSubtotalMinor = toMinorUnits(
          Number(existing.subtotal) || Number(existing.total) || 0,
          'subtotal',
        );
        const discountMinor = toMinorUnits(
          Number(existing.discount) || 0,
          'discount',
        );
        const taxableMinor = Math.max(0, storedSubtotalMinor - discountMinor);
        const vatMinor = Math.round((taxableMinor * 7) / 100);
        const grandTotalMinor = taxableMinor + vatMinor;
        const paidMinor = this.sumPaymentFactsMinor(existing);
        const currentGrandTotalMinor = toMinorUnits(
          existing.grandTotal,
          'grand total',
        );
        const storedPaidMinor = toMinorUnits(
          existing.paidAmount ?? 0,
          'paid amount',
        );
        const storedDepositMinor = toMinorUnits(
          existing.depositTotal ?? 0,
          'deposit total',
        );
        const storedRemainingMinor = toMinorUnits(
          existing.remainingTotal,
          'remaining total',
        );
        const expectedCurrentRemainingMinor = Math.max(
          0,
          currentGrandTotalMinor - paidMinor,
        );
        if (
          paidMinor > currentGrandTotalMinor ||
          storedPaidMinor !== paidMinor ||
          storedDepositMinor !== paidMinor ||
          storedRemainingMinor !== expectedCurrentRemainingMinor
        ) {
          throw new ConflictException(
            'Stored payment totals do not reconcile with payment facts. Reconciliation is required.',
          );
        }

        const vatAmount = fromMinorUnits(vatMinor);
        const grandTotal = fromMinorUnits(grandTotalMinor);
        const remainingMinor = Math.max(0, grandTotalMinor - paidMinor);
        const remainingTotal = fromMinorUnits(remainingMinor);
        let status: OrderStatus = 'partial';
        if (paidMinor <= 0) {
          status = 'awaiting_payment';
        } else if (remainingMinor === 0) {
          status = 'paid';
        }

        const alreadyConverted =
          existing.taxInvoice === 'yes' &&
          hasCompleteInvoiceIdentity &&
          toMinorUnits(existing.grandTotal, 'grand total') ===
            grandTotalMinor &&
          toMinorUnits(existing.vatAmount ?? 0, 'VAT amount') === vatMinor &&
          toMinorUnits(existing.remainingTotal, 'remaining total') ===
            remainingMinor &&
          existing.status === status;
        if (alreadyConverted) {
          return { order: existing, changed: false };
        }

        const existingIssueDate =
          existing.saleDate ??
          (existing.toObject() as OrderPlainObject).createdAt ??
          new Date();
        const allocated = hasCompleteInvoiceIdentity
          ? undefined
          : await this.runningNumberService.generateTaxInvoiceNumber(
              existingIssueDate,
              session,
            );
        const invoiceNumber =
          existing.invoiceNumber ?? allocated?.invoiceNumber;
        const bookNo = existing.bookNo ?? allocated?.bookNo;
        const invoiceSequence =
          existing.invoiceSequence ?? allocated?.invoiceSequence;
        const invoicePeriod =
          existing.invoicePeriod ?? allocated?.invoicePeriod;
        if (!invoiceNumber || !bookNo || !invoiceSequence || !invoicePeriod) {
          throw new InternalServerErrorException(
            'Failed to allocate a complete tax invoice identity.',
          );
        }

        const updated = await this.orderModel
          .findOneAndUpdate(
            { _id: id },
            {
              $set: {
                taxInvoiceRequested: true,
                taxInvoice: 'yes',
                invoiceNumber,
                bookNo,
                invoiceSequence,
                invoicePeriod,
                vatAmount,
                grandTotal,
                remainingTotal,
                status,
              },
            },
            { new: true, runValidators: true, session },
          )
          .exec();
        if (!updated) {
          throw new InternalServerErrorException(
            'Tax invoice conversion did not update the order.',
          );
        }

        return { order: updated, changed: true };
      },
    );

    if (!transactionResult) {
      throw new InternalServerErrorException(
        'Tax invoice conversion transaction returned no result.',
      );
    }

    const response = this.toOrderResponse(transactionResult.order);
    if (transactionResult.changed) {
      this.ordersSse.emitOrder(response);
    }
    return response;
  }

  async cancelOrder(
    id: string,
    reason: string,
    actor: Pick<AuthenticatedUser, 'id'>,
  ): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      throw new BadRequestException('Cancellation reason is required.');
    }

    const existing = await this.orderModel.findById(id).exec();
    if (!existing) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }

    if (this.resolveWorkflowStatus(existing.toObject()) === 'cancelled') {
      return this.toOrderResponse(existing);
    }

    const paidMinor = this.sumPaymentFactsMinor(existing);
    const storedPaidMinor = toMinorUnits(
      existing.paidAmount ?? 0,
      'paid amount',
    );
    const storedDepositMinor = toMinorUnits(
      existing.depositTotal ?? 0,
      'deposit total',
    );
    if (paidMinor !== storedPaidMinor || paidMinor !== storedDepositMinor) {
      throw new ConflictException(
        'Stored payment totals do not reconcile with payment facts. Reconciliation is required before cancellation.',
      );
    }

    const cancelledAt = new Date();
    const financialAdjustments = (existing.payments ?? []).map((payment) => ({
      type: 'refund' as const,
      amount: -fromMinorUnits(toMinorUnits(payment.amount, 'payment amount')),
      method: payment.method,
      reason: normalizedReason,
      occurredAt: cancelledAt,
      changedBy: actor.id,
      ...(payment.idempotencyKey
        ? { sourcePaymentIdempotencyKey: payment.idempotencyKey }
        : {}),
    }));
    const currentWorkflowStatus = this.resolveWorkflowStatus(
      existing.toObject(),
    );
    const workflowPredicate = existing.workflowStatus
      ? { workflowStatus: currentWorkflowStatus }
      : { workflowStatus: { $exists: false } };
    const correctiveDocumentRequired =
      existing.taxInvoice === 'yes' || Boolean(existing.invoiceNumber);
    const statusHistoryEntry = {
      status: 'cancelled' as const,
      note: normalizedReason,
      changedAt: cancelledAt,
      changedBy: actor.id,
    };

    const updated = await this.orderModel
      .findOneAndUpdate(
        {
          _id: id,
          ...workflowPredicate,
          status: existing.status,
          paidAmount: existing.paidAmount,
        },
        {
          $set: {
            status: 'cancelled',
            workflowStatus: 'cancelled',
            remainingTotal: 0,
            cancellation: {
              reason: normalizedReason,
              cancelledAt,
              cancelledBy: actor.id,
              refundedAmount: fromMinorUnits(paidMinor),
              correctiveDocumentRequired,
              correctiveDocumentStatus: correctiveDocumentRequired
                ? 'required'
                : 'not_required',
            },
          },
          $push: {
            statusHistory: statusHistoryEntry,
            ...(financialAdjustments.length
              ? { financialAdjustments: { $each: financialAdjustments } }
              : {}),
          },
        },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updated) {
      const concurrentlyUpdated = await this.orderModel.findById(id).exec();
      if (
        concurrentlyUpdated &&
        this.resolveWorkflowStatus(concurrentlyUpdated.toObject()) ===
          'cancelled'
      ) {
        return this.toOrderResponse(concurrentlyUpdated);
      }
      throw new ConflictException(
        'Order or payment state changed concurrently. Please retry the cancellation.',
      );
    }

    const response = this.toOrderResponse(updated);
    this.emitForStatus(response, 'cancelled');
    return response;
  }

  async getSummary() {
    const metrics = await this.orderReporting.getDashboardMetrics({
      period: 'today',
    });

    return {
      salesToday: metrics.periodSummary.sales,
      cashToday: metrics.paymentSummary.cash,
      promptPayToday: metrics.paymentSummary.transfer,
      completed: metrics.periodSummary.orders,
    };
  }

  exportOrders(query: ExportOrdersQueryDto) {
    return this.orderReporting.buildExport(query);
  }

  async findByOrderId(orderNumber: string): Promise<OrderResponseDto | null> {
    const order = await this.orderModel
      .findOne({
        $or: [{ orderNumber }, { orderId: orderNumber }],
      })
      .exec();
    return order ? this.toOrderResponse(order) : null;
  }

  async addPayment(
    id: string,
    amount: number,
    method: PaymentMethod,
    note?: string,
    idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');
    if (amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than 0.');
    }

    const paymentMinor = toMinorUnits(amount, 'payment amount');
    if (paymentMinor <= 0) {
      throw new BadRequestException('Payment amount must be greater than 0.');
    }
    const paymentAmount = fromMinorUnits(paymentMinor);
    const normalizedIdempotencyKey =
      this.normalizePaymentIdempotencyKey(idempotencyKey);
    const normalizedNote = note?.trim() || undefined;
    const maxAttempts = 5;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const order = await this.orderModel.findById(id).exec();
      if (!order) throw new NotFoundException('Order not found');

      if (normalizedIdempotencyKey) {
        const existingPayment = order.payments.find(
          (payment) => payment.idempotencyKey === normalizedIdempotencyKey,
        );
        if (existingPayment) {
          const existingPaymentMinor = toMinorUnits(
            existingPayment.amount,
            'existing payment amount',
          );
          const existingNote = existingPayment.note?.trim() || undefined;
          if (
            existingPaymentMinor !== paymentMinor ||
            existingPayment.method !== method ||
            existingNote !== normalizedNote
          ) {
            throw new ConflictException(
              'Idempotency key was already used for a different payment.',
            );
          }
          return this.toOrderResponse(order);
        }
      }

      const grandTotalMinor = toMinorUnits(order.grandTotal, 'grand total');
      const currentPaidMinor = this.sumPaymentFactsMinor(order);
      if (currentPaidMinor > grandTotalMinor) {
        throw new ConflictException(
          'Stored payment facts exceed the order grand total. Reconciliation is required.',
        );
      }

      const remainingMinor = grandTotalMinor - currentPaidMinor;
      const storedPaidMinor = toMinorUnits(
        order.paidAmount ?? 0,
        'paid amount',
      );
      const storedDepositMinor = toMinorUnits(
        order.depositTotal ?? 0,
        'deposit total',
      );
      const storedRemainingMinor = toMinorUnits(
        order.remainingTotal,
        'remaining total',
      );
      if (
        storedPaidMinor !== currentPaidMinor ||
        storedDepositMinor !== currentPaidMinor ||
        storedRemainingMinor !== remainingMinor
      ) {
        throw new ConflictException(
          'Stored payment totals do not reconcile with payment facts. Reconciliation is required.',
        );
      }

      if (paymentMinor > remainingMinor) {
        throw new BadRequestException(
          'Payment amount cannot exceed remaining total.',
        );
      }

      const nextPaidMinor = currentPaidMinor + paymentMinor;
      if (nextPaidMinor > grandTotalMinor) {
        throw new BadRequestException(
          'Payment amount cannot exceed remaining total.',
        );
      }

      const expectedPaidAmount = fromMinorUnits(currentPaidMinor);
      const expectedRemainingTotal = fromMinorUnits(remainingMinor);
      const expectedGrandTotal = fromMinorUnits(grandTotalMinor);
      const paidAmount = fromMinorUnits(nextPaidMinor);
      const remainingTotal = fromMinorUnits(grandTotalMinor - nextPaidMinor);
      const status: OrderStatus = remainingTotal === 0 ? 'paid' : 'partial';
      const paidAt = new Date();
      const paymentFilter: Record<string, unknown> = {
        _id: id,
        paidAmount: expectedPaidAmount,
        grandTotal: expectedGrandTotal,
        remainingTotal: {
          $eq: expectedRemainingTotal,
          $gte: paymentAmount,
        },
      };
      if (normalizedIdempotencyKey) {
        paymentFilter['payments.idempotencyKey'] = {
          $ne: normalizedIdempotencyKey,
        };
      }

      const updated = await this.orderModel
        .findOneAndUpdate(
          paymentFilter,
          {
            $set: {
              depositTotal: paidAmount,
              paidAmount,
              remainingTotal,
              status,
            },
            $push: {
              payments: {
                amount: paymentAmount,
                method,
                note,
                ...(normalizedIdempotencyKey
                  ? { idempotencyKey: normalizedIdempotencyKey }
                  : {}),
                paidAt,
              },
              statusHistory: {
                status,
                note,
                changedAt: paidAt,
              },
            },
          },
          { new: true, runValidators: true },
        )
        .exec();

      if (!updated) {
        continue;
      }

      const response = this.toOrderResponse(updated);

      if (status === 'paid') {
        this.ordersSse.emitOrderAndAutoClear(response, 7000);
      } else {
        this.ordersSse.emitOrder(response);
      }

      try {
        if (remainingTotal === 0) {
          await this.notificationsService.autoResolvePaymentNotifications(id);
        } else {
          await this.notificationsService.handleOrderPaymentState(updated);
        }
      } catch (error) {
        this.logger.error(
          'Failed to handle payment notification',
          error instanceof Error ? error.stack : String(error),
        );
      }

      return response;
    }

    throw new ConflictException(
      'Payment state changed concurrently. Please retry the payment.',
    );
  }

  async getOrCreateTrackingAccessToken(id: string): Promise<{ token: string }> {
    this.assertMongoObjectId(id, 'order id');

    const existing = await this.orderModel
      .findById(id)
      .select('+trackingAccessToken +trackingAccessTokenHash')
      .exec();
    if (!existing) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }

    if (existing.trackingAccessToken) {
      const expectedHash = this.hashTrackingAccessToken(
        existing.trackingAccessToken,
      );
      if (existing.trackingAccessTokenHash !== expectedHash) {
        await this.orderModel
          .findByIdAndUpdate(id, {
            $set: { trackingAccessTokenHash: expectedHash },
          })
          .exec();
      }
      return { token: existing.trackingAccessToken };
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomBytes(32).toString('base64url');
      const trackingAccessTokenHash = this.hashTrackingAccessToken(token);

      try {
        const updated = await this.orderModel
          .findOneAndUpdate(
            { _id: id, trackingAccessToken: { $exists: false } },
            {
              $set: {
                trackingAccessToken: token,
                trackingAccessTokenHash,
              },
            },
            { new: true, runValidators: true },
          )
          .select('+trackingAccessToken')
          .exec();

        if (updated?.trackingAccessToken) {
          return { token: updated.trackingAccessToken };
        }
      } catch (error) {
        if (!this.isDuplicateKeyError(error)) throw error;
      }

      const raced = await this.orderModel
        .findById(id)
        .select('+trackingAccessToken')
        .exec();
      if (raced?.trackingAccessToken) {
        return { token: raced.trackingAccessToken };
      }
    }

    throw new InternalServerErrorException(
      'Failed to create tracking access for order.',
    );
  }

  async lookupPublicTracking(
    orderNumber: string,
    phoneSuffix: string,
  ): Promise<PublicTrackingResponseDto | null> {
    const normalizedOrderNumber = orderNumber.trim();
    const normalizedPhoneSuffix = phoneSuffix.trim();
    const order = await this.orderModel
      .findOne({
        $and: [
          {
            $or: [
              { orderNumber: normalizedOrderNumber },
              { orderId: normalizedOrderNumber },
            ],
          },
          { phoneNumber: { $regex: `${normalizedPhoneSuffix}$` } },
        ],
      })
      .exec();
    return order ? await this.buildPublicTrackingResponse(order) : null;
  }

  async lookupPublicTrackingByToken(
    token: string,
  ): Promise<PublicTrackingResponseDto | null> {
    const normalizedToken = token.trim();
    const order = await this.orderModel
      .findOne({
        trackingAccessTokenHash: this.hashTrackingAccessToken(normalizedToken),
      })
      .exec();
    return order ? await this.buildPublicTrackingResponse(order) : null;
  }

  private async buildPublicTrackingResponse(
    order: OrderDocument,
  ): Promise<PublicTrackingResponseDto> {
    const plain = order.toObject() as OrderPlainObject;
    const workflowStatus = this.resolveWorkflowStatus(plain);
    const productionProjection =
      await this.resolveProductionTrackingProjection(order);
    const milestoneByName = new Map<
      PublicTrackingMilestone,
      { milestone: PublicTrackingMilestone; reachedAt?: Date }
    >();

    const setMilestone = (
      milestone: PublicTrackingMilestone,
      reachedAt?: Date,
    ): void => {
      if (milestoneByName.has(milestone)) return;
      milestoneByName.set(milestone, { milestone, reachedAt });
    };

    setMilestone('received', plain.createdAt);

    if (productionProjection) {
      if (productionProjection.inProgressAt) {
        setMilestone('in_progress', productionProjection.inProgressAt);
      }
      if (
        productionProjection.currentMilestone === 'ready' &&
        productionProjection.readyAt
      ) {
        setMilestone('ready', productionProjection.readyAt);
      }
    } else {
      for (const historyEntry of plain.statusHistory ?? []) {
        const milestone = PUBLIC_MILESTONE_BY_STATUS[historyEntry.status];
        if (milestone) setMilestone(milestone, historyEntry.changedAt);
      }
      const workflowMilestone = PUBLIC_MILESTONE_BY_STATUS[workflowStatus];
      if (workflowMilestone) {
        setMilestone(workflowMilestone, plain.updatedAt ?? plain.createdAt);
      }
    }

    if (workflowStatus === 'delivered') {
      const deliveredAt = [...(plain.statusHistory ?? [])]
        .reverse()
        .find((entry) => entry.status === 'delivered')?.changedAt;
      setMilestone(
        'completed',
        deliveredAt ?? plain.updatedAt ?? plain.createdAt,
      );
    } else if (workflowStatus === 'cancelled') {
      const cancelledAt = [...(plain.statusHistory ?? [])]
        .reverse()
        .find((entry) => entry.status === 'cancelled')?.changedAt;
      setMilestone(
        'cancelled',
        cancelledAt ?? plain.updatedAt ?? plain.createdAt,
      );
    }

    const milestones = [...milestoneByName.values()].sort((left, right) => {
      const leftTime = left.reachedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightTime = right.reachedAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftTime - rightTime;
    });

    const currentMilestone: PublicTrackingMilestone =
      workflowStatus === 'delivered'
        ? 'completed'
        : workflowStatus === 'cancelled'
          ? 'cancelled'
          : (productionProjection?.currentMilestone ??
            PUBLIC_MILESTONE_BY_STATUS[workflowStatus] ??
            'received');

    return {
      orderNumber: plain.orderNumber ?? plain.orderId ?? order._id.toString(),
      currentMilestone,
      milestones,
      updatedAt: milestones.at(-1)?.reachedAt ?? plain.updatedAt,
    };
  }

  private async resolveProductionTrackingProjection(
    order: OrderDocument,
  ): Promise<ProductionTrackingProjection | null> {
    if (!this.productionJobModel) return null;

    const jobs = (await this.productionJobModel
      .find({ orderId: order._id })
      .select('stage stageHistory updatedAt')
      .lean()
      .exec()) as ProductionTrackingJob[];

    if (jobs.length === 0) return null;

    const activeStages = new Set<ProductionJobStage>([
      'producing',
      'quality_check',
      'ready',
      'delivered',
    ]);
    const readyStages = new Set<ProductionJobStage>(['ready', 'delivered']);

    const firstActiveAt = (job: ProductionTrackingJob): Date | undefined =>
      job.stageHistory
        .filter((entry) => activeStages.has(entry.stage))
        .map((entry) => entry.changedAt)
        .sort((left, right) => left.getTime() - right.getTime())[0] ??
      (activeStages.has(job.stage) ? job.updatedAt : undefined);

    const readyAt = (job: ProductionTrackingJob): Date | undefined =>
      job.stageHistory
        .filter((entry) => readyStages.has(entry.stage))
        .map((entry) => entry.changedAt)
        .sort((left, right) => left.getTime() - right.getTime())[0] ??
      (readyStages.has(job.stage) ? job.updatedAt : undefined);

    const activeTimes = jobs
      .map(firstActiveAt)
      .filter((value): value is Date => Boolean(value));
    const inProgressAt = activeTimes.sort(
      (left, right) => left.getTime() - right.getTime(),
    )[0];

    const allReady = jobs.every((job) => readyStages.has(job.stage));
    if (allReady) {
      const readyTimes = jobs
        .map(readyAt)
        .filter((value): value is Date => Boolean(value));
      const aggregateReadyAt = readyTimes.sort(
        (left, right) => right.getTime() - left.getTime(),
      )[0];

      return {
        currentMilestone: 'ready',
        inProgressAt,
        readyAt: aggregateReadyAt,
      };
    }

    return {
      currentMilestone: inProgressAt ? 'in_progress' : 'received',
      inProgressAt,
    };
  }

  private resolveWorkflowStatus(plain: OrderPlainObject): OrderWorkflowStatus {
    if (plain.workflowStatus && this.isWorkflowStatus(plain.workflowStatus)) {
      return plain.workflowStatus;
    }

    const history = plain.statusHistory ?? [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const historicalStatus = history[index]?.status;
      if (historicalStatus && this.isWorkflowStatus(historicalStatus)) {
        return historicalStatus;
      }
    }

    return this.isWorkflowStatus(plain.status) ? plain.status : 'pending';
  }

  private isWorkflowStatus(status: OrderStatus): status is OrderWorkflowStatus {
    return ORDER_WORKFLOW_STATUSES.includes(status as OrderWorkflowStatus);
  }

  private hashTrackingAccessToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async updateCustomerInfo(
    id: string,
    updateDto: UpdateOrderCustomerDto,
  ): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');

    const update = this.buildCustomerInfoUpdate(updateDto);

    const updated = await this.orderModel
      .findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .exec();

    if (!updated) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }

    return this.toOrderResponse(updated);
  }

  private normalizePaymentIdempotencyKey(value?: string): string | undefined {
    const normalized = value?.trim();
    if (!normalized) return undefined;
    if (normalized.length > 128) {
      throw new BadRequestException(
        'Payment idempotency key cannot exceed 128 characters.',
      );
    }
    return normalized;
  }

  private sumPaymentFactsMinor(order: OrderDocument): number {
    return (order.payments ?? []).reduce((sum, payment, index) => {
      const paymentMinor = toMinorUnits(
        payment.amount,
        `payments.${index}.amount`,
      );
      const nextSum = sum + paymentMinor;
      if (!Number.isSafeInteger(nextSum)) {
        throw new ConflictException(
          'Stored payment facts exceed the supported money range.',
        );
      }
      return nextSum;
    }, 0);
  }

  private async transitionWorkflowStatus(
    id: string,
    workflowStatus: OrderWorkflowStatus,
    statusNote?: string,
    actorId?: string,
    additionalSet: Partial<Order> = {},
  ): Promise<{ order: OrderDocument; changed: boolean } | null> {
    const existing = await this.orderModel.findById(id).exec();
    if (!existing) return null;

    const plain = existing.toObject() as OrderPlainObject;
    const currentWorkflowStatus = this.resolveWorkflowStatus(plain);

    if (currentWorkflowStatus === workflowStatus) {
      if (!Object.keys(additionalSet).length) {
        return { order: existing, changed: false };
      }

      const updatedSameState = await this.orderModel
        .findByIdAndUpdate(
          id,
          { $set: additionalSet },
          { new: true, runValidators: true },
        )
        .exec();
      return updatedSameState
        ? { order: updatedSameState, changed: false }
        : null;
    }

    if (workflowStatus !== 'cancelled') {
      const expectedNext =
        NEXT_PRODUCTION_WORKFLOW_STATUS[currentWorkflowStatus];
      if (expectedNext !== workflowStatus) {
        throw new ConflictException(
          `Invalid workflow transition from ${currentWorkflowStatus} to ${workflowStatus}.`,
        );
      }
    }

    const workflowPredicate = plain.workflowStatus
      ? { workflowStatus: currentWorkflowStatus }
      : { workflowStatus: { $exists: false } };
    const changedAt = new Date();
    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: id, ...workflowPredicate },
        {
          $set: {
            ...additionalSet,
            workflowStatus,
            ...(workflowStatus === 'cancelled' ? { status: 'cancelled' } : {}),
          },
          $push: {
            statusHistory: {
              status: workflowStatus,
              note: statusNote,
              changedAt,
              ...(actorId ? { changedBy: actorId } : {}),
            },
          },
        },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updated) {
      throw new ConflictException(
        'Workflow state changed concurrently. Please retry the request.',
      );
    }

    return { order: updated, changed: true };
  }

  private assertWorkflowStatusWritable(status: OrderStatus): void {
    if (status === 'cancelled') {
      throw new BadRequestException(
        'Order cancellation requires the dedicated cancellation command and a reason.',
      );
    }
    if (
      status === 'awaiting_payment' ||
      status === 'partial' ||
      status === 'paid'
    ) {
      throw new BadRequestException(
        'Financial status is derived from authoritative payment facts.',
      );
    }
  }

  private assertMongoObjectId(value: string, label: string): void {
    if (!isValidObjectId(value)) {
      throw new BadRequestException(`Invalid ${label}.`);
    }
  }

  private normalizeCreateIdentity(
    orderDto: CreateOrderDto,
    idempotencyKey?: string,
  ): CreateOrderIdentity {
    const normalizedIdempotencyKey = idempotencyKey?.trim() || undefined;

    return {
      clientDraftId: orderDto.clientDraftId?.trim() || normalizedIdempotencyKey,
      idempotencyKey: normalizedIdempotencyKey,
    };
  }

  private buildCreateCommandFingerprint(
    orderDto: CreateOrderDto,
    identity: CreateOrderIdentity,
    actorId?: string,
  ): string {
    const payload = { ...orderDto } as Record<string, unknown>;
    delete payload.clientDraftId;

    const canonicalCommand = this.canonicalizeCreateCommand({
      actorId: actorId ?? 'unauthenticated',
      identity: {
        clientDraftId: identity.clientDraftId ?? null,
        idempotencyKey: identity.idempotencyKey ?? null,
      },
      payload,
    });

    return createHash('sha256')
      .update(JSON.stringify(canonicalCommand))
      .digest('hex');
  }

  private canonicalizeCreateCommand(value: unknown): unknown {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalizeCreateCommand(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, this.canonicalizeCreateCommand(item)]),
      );
    }
    return value;
  }

  private assertCreateReplayMatches(
    existing: OrderDocument,
    commandFingerprint: string | undefined,
  ): void {
    if (
      !commandFingerprint ||
      !existing.createCommandFingerprint ||
      existing.createCommandFingerprint !== commandFingerprint
    ) {
      throw new ConflictException(
        'Idempotency identity was already used for a different or unverifiable order command.',
      );
    }
  }

  private async findExistingOrderForCreate(identity: CreateOrderIdentity) {
    const candidates: Record<string, string>[] = [];
    if (identity.clientDraftId) {
      candidates.push({ clientDraftId: identity.clientDraftId });
    }
    if (identity.idempotencyKey) {
      candidates.push({ idempotencyKey: identity.idempotencyKey });
    }
    if (candidates.length === 0) {
      return null;
    }

    return this.orderModel.findOne({ $or: candidates }).exec();
  }

  private async persistNewOrder(
    orderDto: CreateOrderDto,
    identity: CreateOrderIdentity,
    actorRole?: UserRole,
    actorId?: string,
    commandFingerprint?: string,
  ): Promise<OrderResponseDto> {
    const normalizedOrder = await this.normalizeOrderForCreate(
      orderDto,
      actorRole,
    );
    const orderNumber = await this.runningNumberService.generateOrderNumber();
    const taxInvoiceNumber =
      normalizedOrder.taxInvoice === 'yes'
        ? await this.runningNumberService.generateTaxInvoiceNumber(
            normalizedOrder.saleDate,
          )
        : undefined;
    const status = normalizedOrder.status ?? 'pending';
    const createdOrder = new this.orderModel({
      ...normalizedOrder,
      ...(identity.clientDraftId
        ? { clientDraftId: identity.clientDraftId }
        : {}),
      ...(identity.idempotencyKey
        ? { idempotencyKey: identity.idempotencyKey }
        : {}),
      ...(commandFingerprint
        ? { createCommandFingerprint: commandFingerprint }
        : {}),
      orderNumber,
      ...(taxInvoiceNumber
        ? {
            invoiceNumber: taxInvoiceNumber.invoiceNumber,
            bookNo: taxInvoiceNumber.bookNo,
            invoiceSequence: taxInvoiceNumber.invoiceSequence,
            invoicePeriod: taxInvoiceNumber.invoicePeriod,
          }
        : {}),
      status,
      statusHistory: [
        {
          status,
          changedAt: new Date(),
          ...(actorId ? { changedBy: actorId } : {}),
        },
      ],
    });
    createdOrder.orderId = createdOrder._id.toString();

    const saved = await createdOrder.save();
    const response = this.toOrderResponse(saved);
    this.ordersSse.emitOrder(response);

    try {
      await this.notificationsService.handleOrderPaymentState(saved);
    } catch (error) {
      this.logger.error(
        'Failed to evaluate action-center state for new order',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return response;
  }

  private async recoverFromCreateError(
    error: unknown,
    identity: CreateOrderIdentity,
    commandFingerprint: string | undefined,
    attempt: number,
    maxAttempts: number,
  ): Promise<OrderResponseDto | null> {
    if (this.isDuplicateOrderNumberError(error)) {
      if (attempt < maxAttempts) {
        return null;
      }

      throw new ConflictException('Failed to generate a unique order number.');
    }

    if (!this.isDuplicateKeyError(error)) {
      throw error;
    }

    const existing = await this.findOrderAfterDuplicateKey(error, identity);
    if (existing) {
      this.assertCreateReplayMatches(existing, commandFingerprint);
      return this.toOrderResponse(existing);
    }

    throw new ConflictException('Duplicate value violates a unique index.');
  }

  private async findOrderAfterDuplicateKey(
    error: MongoServerError,
    identity: CreateOrderIdentity,
  ) {
    if (identity.clientDraftId && this.isDuplicateClientDraftIdError(error)) {
      const existing = await this.orderModel
        .findOne({ clientDraftId: identity.clientDraftId })
        .exec();
      if (existing) {
        return existing;
      }
    }

    if (!identity.idempotencyKey) {
      return null;
    }

    return this.orderModel
      .findOne({ idempotencyKey: identity.idempotencyKey })
      .exec();
  }

  private toSafePartialRegex(value: string): string {
    return value.trim().replace(REGEX_SPECIAL_CHARS, String.raw`\$&`);
  }

  private isDuplicateOrderNumberError(error: unknown): boolean {
    if (!this.isDuplicateKeyError(error)) {
      return false;
    }

    const keyPattern = (
      error as MongoServerError & {
        keyPattern?: Record<string, unknown>;
      }
    ).keyPattern;

    return Boolean(keyPattern?.orderNumber);
  }

  private isDuplicateKeyError(error: unknown): error is MongoServerError {
    return error instanceof MongoServerError && error.code === 11000;
  }

  private isDuplicateClientDraftIdError(error: unknown): boolean {
    if (!this.isDuplicateKeyError(error)) {
      return false;
    }

    const keyPattern = (
      error as MongoServerError & {
        keyPattern?: Record<string, unknown>;
      }
    ).keyPattern;

    return Boolean(keyPattern?.clientDraftId);
  }

  private buildCustomerInfoUpdate(
    updateDto: UpdateOrderCustomerDto,
  ): Partial<Order> {
    const update: Partial<Order> = {};

    Object.assign(
      update,
      this.buildCartItemNameUpdate(updateDto.itemNames ?? []),
    );

    if (updateDto.customerName !== undefined) {
      update.customerName = updateDto.customerName;
    }

    if (updateDto.companyName !== undefined) {
      update.companyName = updateDto.companyName;
    }

    if (updateDto.phoneNumber !== undefined) {
      update.phoneNumber = updateDto.phoneNumber;
    }

    const email = this.resolveMirroredField(
      'email',
      updateDto.email,
      updateDto.customerEmail,
    );
    if (email !== undefined) {
      update.email = email;
      update.customerEmail = email;
    }

    const taxId = this.resolveMirroredField(
      'taxId',
      updateDto.taxId,
      updateDto.customerTaxId,
    );
    if (taxId !== undefined) {
      update.taxId = taxId;
      update.customerTaxId = taxId;
    }

    const address = this.resolveMirroredField(
      'address',
      updateDto.address,
      updateDto.customerAddress,
    );
    if (address !== undefined) {
      update.address = address;
      update.customerAddress = address;
    }

    const branch = this.resolveMirroredField(
      'branch',
      updateDto.branch,
      updateDto.customerBranch,
    );
    if (branch !== undefined) {
      update.branch = branch;
      update.customerBranch = branch;
    }

    if (updateDto.branchType !== undefined) {
      update.branchType = updateDto.branchType;
    }
    if (updateDto.branchNo !== undefined) {
      update.branchNo = updateDto.branchNo;
    }
    if (updateDto.subDistrict !== undefined) {
      update.subDistrict = updateDto.subDistrict;
    }
    if (updateDto.district !== undefined) {
      update.district = updateDto.district;
    }
    if (updateDto.province !== undefined) {
      update.province = updateDto.province;
    }
    if (updateDto.postalCode !== undefined) {
      update.postalCode = updateDto.postalCode;
    }
    if (updateDto.shippingAddress !== undefined) {
      update.shippingAddress = updateDto.shippingAddress;
    }

    if (Object.keys(update).length === 0) {
      throw new BadRequestException(
        'At least one customer field must be provided.',
      );
    }

    return update;
  }

  private buildCartItemNameUpdate(itemNames: string[]): Record<string, string> {
    return Object.fromEntries(
      itemNames.map((name, index) => [`cart.${index}.name`, name]),
    );
  }

  private resolveMirroredField(
    fieldName: 'taxId' | 'address' | 'email' | 'branch',
    primaryValue?: string,
    legacyValue?: string,
  ): string | undefined {
    if (primaryValue !== undefined && legacyValue !== undefined) {
      if (primaryValue !== legacyValue) {
        throw new BadRequestException(
          `"${fieldName}" and legacy alias must match when both are provided.`,
        );
      }

      return primaryValue;
    }

    return primaryValue ?? legacyValue;
  }

  private async normalizeOrderForCreate(
    orderDto: CreateOrderDto,
    actorRole?: UserRole,
  ): Promise<Partial<Order>> {
    const now = new Date();
    const entryMode = orderDto.entryMode ?? 'normal';
    const backdatedSale =
      entryMode === 'backdated'
        ? normalizeBackdatedSale({
            saleDate: orderDto.saleDate,
            backdatedReason: orderDto.backdatedReason,
            now,
          })
        : null;
    const saleDate = backdatedSale?.saleDate ?? now;

    const orderType = orderDto.orderType ?? 'NORMAL';
    const cart = await this.orderPricing.resolveCart(
      orderType,
      orderDto.cart ?? [],
      actorRole,
    );
    const taxInvoice = orderDto.taxInvoice ?? 'no';
    const money = calculateOrderMoney(
      cart.map((item) => ({
        quantity: item.qty,
        unitPrice: item.unitPrice,
      })),
      orderDto.discount,
      orderDto.initialPayment,
      taxInvoice,
    );
    const payment = orderDto.initialPayment?.method ?? 'cash';
    const payments = orderDto.initialPayment
      ? [
          {
            amount: money.paidAmount,
            method: orderDto.initialPayment.method,
            paidAt: now,
          },
        ]
      : [];

    let customerId: Types.ObjectId | undefined;
    if (orderDto.customerId) {
      if (!this.customerModel) {
        throw new InternalServerErrorException(
          'Customer directory is unavailable.',
        );
      }
      const selectedCustomer = await this.customerModel
        .findOne({ _id: orderDto.customerId, active: true })
        .select('_id')
        .lean()
        .exec();
      if (!selectedCustomer) {
        throw new BadRequestException(
          'Selected customer does not exist or is inactive.',
        );
      }
      customerId = new Types.ObjectId(orderDto.customerId);
    }

    return {
      orderType,
      ...(customerId ? { customerId } : {}),
      customerName: orderDto.customerName ?? '',
      companyName: orderDto.companyName,
      phoneNumber: orderDto.phoneNumber ?? '',
      email: orderDto.email ?? orderDto.customerEmail,
      customerEmail: orderDto.customerEmail ?? orderDto.email,
      address: orderDto.address ?? orderDto.customerAddress,
      customerAddress: orderDto.customerAddress ?? orderDto.address,
      taxId: orderDto.taxId ?? orderDto.customerTaxId,
      customerTaxId: orderDto.customerTaxId ?? orderDto.taxId,
      branch: orderDto.branch ?? orderDto.customerBranch,
      customerBranch: orderDto.customerBranch ?? orderDto.branch,
      branchType: orderDto.branchType,
      branchNo: orderDto.branchNo,
      subDistrict: orderDto.subDistrict,
      district: orderDto.district,
      province: orderDto.province,
      postalCode: orderDto.postalCode,
      shippingAddress: orderDto.shippingAddress,
      note: orderDto.note ?? '',
      salesChannel: orderDto.salesChannel,
      total: money.subtotal,
      subtotal: money.subtotal,
      discount: money.discount,
      grandTotal: money.grandTotal,
      depositTotal: money.paidAmount,
      paidAmount: money.paidAmount,
      remainingTotal: money.remainingTotal,
      payment,
      paymentMethod: payment,
      status: money.status,
      workflowStatus: 'pending',
      saleDate,
      entryMode,
      isBackdated: entryMode === 'backdated',
      backdatedReason: backdatedSale?.backdatedReason,
      taxInvoiceRequested: taxInvoice === 'yes',
      taxInvoice,
      vatAmount: money.vatAmount,
      receivedAmount: money.receivedAmount,
      changeAmount: money.changeAmount,
      payments,
      cart,
    };
  }

  private emitForStatus(response: OrderResponseDto, status: OrderStatus): void {
    if (
      status === 'pending' ||
      status === 'partial' ||
      status === 'producing' ||
      status === 'awaiting_payment' ||
      status === 'ready_for_pickup'
    ) {
      this.ordersSse.emitOrder(response);
    } else if (status === 'paid' || status === 'delivered') {
      this.ordersSse.emitOrderAndAutoClear(response, 7000);
    } else if (status === 'cancelled') {
      this.ordersSse.emitOrder(null);
    }

    const workflowStatus = ORDER_WORKFLOW_STATUSES.includes(
      status as OrderWorkflowStatus,
    )
      ? (status as OrderWorkflowStatus)
      : response.workflowStatus;

    void this.notificationsService
      .handleOrderStatusChange({
        _id: response._id,
        status: workflowStatus,
        orderNumber: response.orderNumber,
        customerName: response.customerName,
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Failed to handle status change notification',
          error instanceof Error ? error.stack : String(error),
        );
      });
  }

  private toOrderResponse(order: OrderDocument): OrderResponseDto {
    const plain = order.toObject() as OrderPlainObject;
    const resolvedAddress = plain.address ?? plain.customerAddress;
    const resolvedTaxId = plain.taxId ?? plain.customerTaxId;
    const resolvedEmail = plain.email ?? plain.customerEmail;
    const resolvedBranch = plain.branch ?? plain.customerBranch;

    return {
      orderType: plain.orderType ?? 'NORMAL',
      _id: order._id.toString(),
      clientDraftId: plain.clientDraftId,
      idempotencyKey: plain.idempotencyKey,
      orderId: plain.orderId ?? order._id.toString(),
      saleDate: plain.saleDate ?? plain.createdAt,
      entryMode: plain.entryMode ?? (plain.saleDate ? 'backdated' : 'normal'),
      isBackdated:
        plain.isBackdated ??
        Boolean(
          plain.saleDate &&
            plain.saleDate.getTime() !== plain.createdAt?.getTime(),
        ),
      backdatedReason: plain.backdatedReason,
      orderNumber: plain.orderNumber,
      quotationId: plain.quotationId?.toString(),
      quotationNumber: plain.quotationNumber,
      quotationRevision: plain.quotationRevision,
      invoiceNumber: plain.invoiceNumber,
      bookNo: plain.bookNo,
      invoiceSequence: plain.invoiceSequence,
      invoicePeriod: plain.invoicePeriod,
      customerName: plain.customerName,
      companyName: plain.companyName,
      phoneNumber: plain.phoneNumber,
      email: resolvedEmail,
      customerEmail: plain.customerEmail ?? resolvedEmail,
      address: resolvedAddress,
      customerAddress: plain.customerAddress ?? resolvedAddress,
      taxId: resolvedTaxId,
      customerTaxId: plain.customerTaxId ?? resolvedTaxId,
      branch: resolvedBranch,
      customerBranch: plain.customerBranch ?? resolvedBranch,
      branchType: plain.branchType,
      branchNo: plain.branchNo,
      subDistrict: plain.subDistrict,
      district: plain.district,
      province: plain.province,
      postalCode: plain.postalCode,
      shippingAddress: plain.shippingAddress,
      note: plain.note,
      salesChannel: plain.salesChannel,
      total: plain.total,
      subtotal: plain.subtotal ?? plain.total,
      discount: plain.discount,
      depositTotal: plain.depositTotal,
      paidAmount: plain.paidAmount ?? plain.depositTotal,
      remainingTotal: plain.remainingTotal,
      payment: plain.payment,
      paymentMethod: plain.paymentMethod ?? plain.payment,
      status: plain.status,
      workflowStatus: this.resolveWorkflowStatus(plain),
      taxInvoiceRequested:
        plain.taxInvoiceRequested ?? plain.taxInvoice === 'yes',
      taxInvoice: plain.taxInvoice,
      vatAmount: plain.vatAmount,
      grandTotal: plain.grandTotal,
      receivedAmount: plain.receivedAmount,
      changeAmount: plain.changeAmount,
      payments: (plain.payments ?? []).map((payment) => ({
        amount: payment.amount,
        method: payment.method,
        note: payment.note,
        paidAt: payment.paidAt,
      })),
      financialAdjustments: plain.financialAdjustments ?? [],
      cancellation: plain.cancellation,
      statusHistory: plain.statusHistory ?? [],
      cart: plain.cart,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
    };
  }
}
