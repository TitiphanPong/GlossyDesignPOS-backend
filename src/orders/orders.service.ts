import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { isValidObjectId, Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { OrderResponseDto } from './dto/order-response.dto';
import {
  TrackingOrderResponseDto,
  TrackingSearchResponseDto,
} from './dto/tracking-response.dto';
import { UpdateOrderCustomerDto } from './dto/update-order-customer.dto';
import { ListOrdersQueryDto } from './dto/list-orders-query.dto';
import { ExportOrdersQueryDto } from './dto/list-orders-query.dto';
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
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly runningNumberService: RunningNumberService,
    private readonly ordersSse: OrdersSseService,
    private readonly orderPricing: OrderPricingService,
    @Optional() private readonly orderReporting: OrderReportingService,
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
    if (
      status === 'awaiting_payment' ||
      status === 'partial' ||
      status === 'paid'
    ) {
      throw new BadRequestException(
        'Financial status is derived from authoritative payment facts.',
      );
    }
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

    const invoiceNumber =
      existing.invoiceNumber ??
      (await this.runningNumberService.generateTaxInvoiceNumber());
    const paidAmount = Number(existing.paidAmount) || 0;
    const remainingTotal = Math.max(
      0,
      Math.round((grandTotal - paidAmount) * 100) / 100,
    );
    const status: OrderStatus =
      paidAmount <= 0
        ? 'awaiting_payment'
        : remainingTotal === 0
          ? 'paid'
          : 'partial';
    const updated = await this.orderModel
      .findOneAndUpdate(
        { _id: id },
        {
          $set: {
            taxInvoice: 'yes',
            invoiceNumber,
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
  ): Promise<OrderResponseDto> {
    this.assertMongoObjectId(id, 'order id');
    const order = await this.orderModel.findById(id);
    if (!order) throw new NotFoundException('Order not found');

    if (amount <= 0) {
      throw new BadRequestException('Payment amount must be greater than 0.');
    }
    if (amount > order.remainingTotal) {
      throw new BadRequestException(
        'Payment amount cannot exceed remaining total.',
      );
    }

    const paymentMinor = toMinorUnits(amount, 'payment amount');
    const grandTotalMinor = toMinorUnits(order.grandTotal, 'grand total');
    const paidMinor =
      toMinorUnits(order.paidAmount ?? 0, 'paid amount') + paymentMinor;
    order.depositTotal = fromMinorUnits(paidMinor);
    order.paidAmount = fromMinorUnits(paidMinor);
    order.remainingTotal = fromMinorUnits(grandTotalMinor - paidMinor);
    order.payments.push({
      amount: fromMinorUnits(paymentMinor),
      method,
      note,
      paidAt: new Date(),
    });
    order.status = order.remainingTotal === 0 ? 'paid' : 'partial';
    order.statusHistory.push({
      status: order.status,
      note,
      changedAt: new Date(),
    });

    const updated = await order.save();
    const response = this.toOrderResponse(updated);

    if (order.status === 'paid') {
      this.ordersSse.emitOrderAndAutoClear(response, 7000);
    } else {
      this.ordersSse.emitOrder(response);
    }

    return response;
  }

  async findTrackingByOrderNumber(
    orderNumber: string,
  ): Promise<TrackingOrderResponseDto | null> {
    const order = await this.orderModel
      .findOne({ $or: [{ orderNumber }, { orderId: orderNumber }] })
      .exec();
    return order ? this.toTrackingResponse(order) : null;
  }

  async searchTracking(query: {
    orderNumber?: string;
    phone?: string;
    q?: string;
  }): Promise<TrackingSearchResponseDto> {
    const filter: Record<string, unknown> = {};
    const or: Record<string, unknown>[] = [];
    if (query.q?.trim()) {
      const pattern = this.toSafePartialRegex(query.q);
      or.push(
        { orderNumber: { $regex: pattern, $options: 'i' } },
        { orderId: { $regex: pattern, $options: 'i' } },
        { phoneNumber: { $regex: pattern, $options: 'i' } },
      );
    }
    if (query.orderNumber?.trim()) {
      const pattern = this.toSafePartialRegex(query.orderNumber);
      or.push(
        { orderNumber: { $regex: pattern, $options: 'i' } },
        { orderId: { $regex: pattern, $options: 'i' } },
      );
    }
    if (query.phone?.trim()) {
      filter.phoneNumber = {
        $regex: this.toSafePartialRegex(query.phone),
        $options: 'i',
      };
    }
    if (or.length) {
      filter.$or = or;
    }

    if (!Object.keys(filter).length) {
      throw new BadRequestException('q, orderNumber, or phone is required.');
    }

    const rows = await this.orderModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(10)
      .exec();
    const data = rows.map((order) => this.toTrackingResponse(order));
    return { data, total: data.length };
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
    const invoiceNumber =
      normalizedOrder.taxInvoice === 'yes'
        ? await this.runningNumberService.generateTaxInvoiceNumber()
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
      ...(invoiceNumber ? { invoiceNumber } : {}),
      status,
      statusHistory: [{ status, changedAt: new Date() }],
    });
    createdOrder.orderId = createdOrder._id.toString();

    const saved = await createdOrder.save();
    const response = this.toOrderResponse(saved);
    this.ordersSse.emitOrder(response);
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

  private toTrackingResponse(order: OrderDocument): TrackingOrderResponseDto {
    const plain = order.toObject() as OrderPlainObject;
    const id = order._id.toString();

    return {
      orderType: plain.orderType ?? 'NORMAL',
      _id: id,
      orderId: plain.orderId ?? id,
      orderNumber: plain.orderNumber,
      invoiceNumber: plain.invoiceNumber,
      status: plain.status,
      customerName: plain.customerName,
      phoneNumber: plain.phoneNumber
        ? this.maskPhone(plain.phoneNumber)
        : undefined,
      phone: plain.phoneNumber ? this.maskPhone(plain.phoneNumber) : undefined,
      total: plain.total,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
      cart: (plain.cart ?? []).map((item) => ({
        name: item.name,
        category: item.category,
        variantName: item.variantName,
        variant: item.variant,
        qty: item.qty,
        quantity: item.qty,
        price: item.unitPrice,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        lineTotal: item.lineTotal ?? item.totalPrice,
        sides: item.sides,
        material: item.material,
        colorMode: item.colorMode,
        type: item.type,
        typePremium: item.typePremium,
        shape: item.shape,
        size: item.size,
        setCount: item.setCount,
        inkjetType: item.inkjetType,
        sizeFlex: item.sizeFlex,
        stickerPVCType: item.stickerPVCType,
        plotPlanType: item.plotPlanType,
        deposit: item.deposit,
        remaining: item.remaining,
        fullPayment: item.fullPayment,
        note: item.note ?? item.productNote,
        productNote: item.productNote,
      })),
      items: (plain.cart ?? []).map((item) => ({
        name: item.name,
        category: item.category,
        variantName: item.variantName,
        qty: item.qty,
      })),
      grandTotal: plain.grandTotal ?? plain.total,
      paidAmount: plain.paidAmount ?? plain.depositTotal ?? 0,
      remainingTotal: plain.remainingTotal,
      statusHistory: plain.statusHistory ?? [],
      estimatedReadyAt: (plain as { estimatedReadyAt?: Date }).estimatedReadyAt,
    };
  }

  private maskPhone(phone: string): string {
    const digits = phone.trim();
    if (digits.length <= 4) {
      return '****';
    }
    return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
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
      payments: plain.payments,
      statusHistory: plain.statusHistory ?? [],
      cart: plain.cart,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
    };
  }
}
