import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { isValidObjectId, Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { PublicTrackingResponseDto } from './dto/tracking-response.dto';
import { UpdateOrderCustomerDto } from './dto/update-order-customer.dto';
import {
  ExportOrdersQueryDto,
  ListOrdersQueryDto,
} from './dto/list-orders-query.dto';
import {
  Order,
  OrderDocument,
  OrderStatus,
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
import { UserRole } from '../auth/auth.constants';
import { NotificationsService } from '../notifications/notifications.service';
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
type ListOrdersResponse = {
  data: OrderResponseDto[];
  page: number;
  limit: number;
  total: number;
  summary: OrderReportSummary;
};

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

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
  ) {}

  async create(
    orderDto: CreateOrderDto,
    idempotencyKey?: string,
    actorRole?: UserRole,
  ): Promise<OrderResponseDto> {
    const identity = this.normalizeCreateIdentity(orderDto, idempotencyKey);
    const existing = await this.findExistingOrderForCreate(identity);
    if (existing) {
      return this.toOrderResponse(existing);
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.persistNewOrder(orderDto, identity, actorRole);
      } catch (error) {
        const recovered = await this.recoverFromCreateError(
          error,
          identity,
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
  ): Promise<OrderResponseDto | null> {
    this.assertWorkflowStatusWritable(status);
    this.assertMongoObjectId(id, 'order id');
    const updated = await this.orderModel
      .findByIdAndUpdate(
        id,
        {
          $set: { status },
          $push: {
            statusHistory: {
              status,
              note: statusNote,
              changedAt: new Date(),
            },
          },
        },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updated) return null;

    const response = this.toOrderResponse(updated);

    this.emitForStatus(response, status);

    return response;
  }

  async updateOrder(
    id: string,
    updateDto: UpdateOrderCustomerDto,
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
      const updated = await this.updateStatus(id, status, statusNote);
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

    if (status !== undefined) {
      update.status = status;
    }

    if (!Object.keys(update).length) {
      throw new BadRequestException(
        'At least one order field must be provided.',
      );
    }

    const mongoUpdate: Record<string, unknown> = { $set: update };
    if (status !== undefined) {
      mongoUpdate.$push = {
        statusHistory: {
          status,
          note: statusNote,
          changedAt: new Date(),
        },
      };
    }

    const updated = await this.orderModel
      .findByIdAndUpdate(id, mongoUpdate, { new: true, runValidators: true })
      .exec();

    if (!updated) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }

    const response = this.toOrderResponse(updated);
    if (status !== undefined) {
      this.emitForStatus(response, status);
    }
    return response;
  }

  async convertToTaxInvoice(id: string): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');
    const existing = await this.orderModel.findById(id).exec();
    if (!existing) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }
    const storedSubtotal =
      Number(existing.subtotal) || Number(existing.total) || 0;
    const taxableAmount = Math.max(
      0,
      storedSubtotal - (Number(existing.discount) || 0),
    );
    const vatAmount = Math.round(taxableAmount * 0.07 * 100) / 100;
    const grandTotal = Math.round((taxableAmount + vatAmount) * 100) / 100;
    if (
      existing.taxInvoice === 'yes' &&
      Number(existing.grandTotal) === grandTotal &&
      Number(existing.vatAmount) === vatAmount
    ) {
      return this.toOrderResponse(existing);
    }

    const existingIssueDate =
      existing.saleDate ??
      (existing.toObject() as OrderPlainObject).createdAt ??
      new Date();
    const taxInvoiceNumber =
      existing.invoiceNumber &&
      existing.bookNo &&
      existing.invoiceSequence &&
      existing.invoicePeriod
        ? undefined
        : await this.runningNumberService.generateTaxInvoiceNumber(
            existingIssueDate,
          );
    const invoiceNumber =
      existing.invoiceNumber ?? taxInvoiceNumber?.invoiceNumber;
    const bookNo = existing.bookNo ?? taxInvoiceNumber?.bookNo;
    const invoiceSequence =
      existing.invoiceSequence ?? taxInvoiceNumber?.invoiceSequence;
    const invoicePeriod =
      existing.invoicePeriod ?? taxInvoiceNumber?.invoicePeriod;
    const paidAmount = Number(existing.paidAmount) || 0;
    const remainingTotal = Math.max(
      0,
      Math.round((grandTotal - paidAmount) * 100) / 100,
    );
    let status: OrderStatus = 'partial';
    if (paidAmount <= 0) {
      status = 'awaiting_payment';
    } else if (remainingTotal === 0) {
      status = 'paid';
    }
    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: id },
        {
          $set: {
            taxInvoice: 'yes',
            invoiceNumber,
            ...(bookNo ? { bookNo } : {}),
            ...(invoiceSequence ? { invoiceSequence } : {}),
            ...(invoicePeriod ? { invoicePeriod } : {}),
            vatAmount,
            grandTotal,
            remainingTotal,
            status,
          },
        },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updated) {
      const latest = await this.orderModel.findById(id).exec();
      if (!latest)
        throw new NotFoundException(`Order not found for id "${id}".`);
      return this.toOrderResponse(latest);
    }

    const response = this.toOrderResponse(updated);
    this.ordersSse.emitOrder(response);
    return response;
  }

  async deleteOrder(id: string): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');
    const deleted = await this.orderModel.findByIdAndDelete(id).exec();
    if (!deleted) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }
    return this.toOrderResponse(deleted);
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
    if (!order) return null;

    const plain = order.toObject() as OrderPlainObject;
    return {
      orderNumber: plain.orderNumber ?? plain.orderId ?? order._id.toString(),
      status: plain.status,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
    };
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

  private assertWorkflowStatusWritable(status: OrderStatus): void {
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
      statusHistory: [{ status, changedAt: new Date() }],
    });
    createdOrder.orderId = createdOrder._id.toString();

    const saved = await createdOrder.save();
    const response = this.toOrderResponse(saved);
    this.ordersSse.emitOrder(response);

    try {
      const savedOrderId = String(saved._id);
      await this.notificationsService.createNotification({
        type: 'order_created',
        category: 'action_required',
        priority: 'high',
        title: `รายการขายใหม่ #${saved.orderNumber}`,
        message: `${saved.customerName || 'ลูกค้า'} รอการยืนยัน`,
        orderId: savedOrderId,
        orderCode: saved.orderNumber,
        customerName: saved.customerName,
        entityType: 'order',
        entityId: savedOrderId,
        notificationKey: `order_created:${savedOrderId}`,
        action: {
          label: 'ยืนยันรายการ',
          href: `/home/orders/${savedOrderId}`,
        },
      });
    } catch (error) {
      this.logger.error(
        'Failed to create notification for new order',
        error instanceof Error ? error.stack : String(error),
      );
    }

    return response;
  }

  private async recoverFromCreateError(
    error: unknown,
    identity: CreateOrderIdentity,
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
    const saleDate =
      entryMode === 'backdated' ? new Date(orderDto.saleDate ?? '') : now;

    if (
      entryMode === 'backdated' &&
      (!orderDto.saleDate || Number.isNaN(saleDate.getTime()))
    ) {
      throw new BadRequestException(
        'saleDate is required for a backdated order.',
      );
    }
    if (saleDate.getTime() > now.getTime()) {
      throw new BadRequestException('saleDate cannot be in the future.');
    }

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

    return {
      orderType,
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
      saleDate,
      entryMode,
      isBackdated: entryMode === 'backdated',
      backdatedReason:
        entryMode === 'backdated'
          ? orderDto.backdatedReason?.trim() || undefined
          : undefined,
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

    void this.notificationsService
      .handleOrderStatusChange({
        _id: response._id,
        status,
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
      statusHistory: plain.statusHistory ?? [],
      cart: plain.cart,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
    };
  }
}
