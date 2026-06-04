import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { isValidObjectId, Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { UpdateOrderCustomerDto } from './dto/update-order-customer.dto';
import {
  Order,
  OrderDocument,
  OrderStatus,
  PaymentMethod,
} from './orders.schema';
import { OrdersSseService } from './orders.sse.service';
import { CreateOrderDto } from './dto/order.dto';

type AggregateTotal = { _id: null; total: number };
type OrderPlainObject = Order & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private readonly orderModel: Model<OrderDocument>,
    private readonly runningNumberService: RunningNumberService,
    private readonly ordersSse: OrdersSseService,
  ) {}

  async create(
    orderDto: CreateOrderDto,
    idempotencyKey?: string,
  ): Promise<OrderResponseDto> {
    const normalizedDraftId =
      orderDto.clientDraftId?.trim() || idempotencyKey?.trim();
    const normalizedIdempotencyKey = idempotencyKey?.trim();
    if (normalizedDraftId || normalizedIdempotencyKey) {
      const existing = await this.orderModel
        .findOne({
          $or: [
            ...(normalizedDraftId
              ? [{ clientDraftId: normalizedDraftId }]
              : []),
            ...(normalizedIdempotencyKey
              ? [{ idempotencyKey: normalizedIdempotencyKey }]
              : []),
          ],
        })
        .exec();
      if (existing) {
        return this.toOrderResponse(existing);
      }
    }

    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const orderNumber =
          await this.runningNumberService.generateOrderNumber();
        const normalizedOrder = this.normalizeOrderForCreate(orderDto);
        const createdOrder = new this.orderModel({
          ...normalizedOrder,
          ...(normalizedDraftId ? { clientDraftId: normalizedDraftId } : {}),
          ...(normalizedIdempotencyKey
            ? { idempotencyKey: normalizedIdempotencyKey }
            : {}),
          orderNumber,
          status: normalizedOrder.status ?? 'pending',
          statusHistory: [
            {
              status: normalizedOrder.status ?? 'pending',
              changedAt: new Date(),
            },
          ],
        });
        createdOrder.orderId = createdOrder._id.toString();
        const saved = await createdOrder.save();
        const response = this.toOrderResponse(saved);

        this.ordersSse.emitOrder(response);

        return response;
      } catch (error) {
        if (this.isDuplicateOrderNumberError(error)) {
          if (attempt === maxAttempts) {
            throw new ConflictException(
              'Failed to generate a unique order number.',
            );
          }

          continue;
        }

        if (this.isDuplicateKeyError(error)) {
          if (normalizedDraftId && this.isDuplicateClientDraftIdError(error)) {
            const existing = await this.orderModel
              .findOne({ clientDraftId: normalizedDraftId })
              .exec();
            if (existing) {
              return this.toOrderResponse(existing);
            }
          }
          if (normalizedIdempotencyKey) {
            const existing = await this.orderModel
              .findOne({ idempotencyKey: normalizedIdempotencyKey })
              .exec();
            if (existing) {
              return this.toOrderResponse(existing);
            }
          }

          throw new ConflictException(
            'Duplicate value violates a unique index.',
          );
        }

        throw error;
      }
    }

    throw new InternalServerErrorException('Failed to create order.');
  }

  async findAll(): Promise<OrderResponseDto[]> {
    const orders = await this.orderModel.find().sort({ createdAt: -1 }).exec();
    return orders.map((order) => this.toOrderResponse(order));
  }

  async findById(id: string): Promise<OrderResponseDto | null> {
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

  async trackOrder(
    query?: string,
  ): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const q = query?.trim();
    if (!q) {
      throw new BadRequestException('q is required.');
    }

    const rows = await this.orderModel
      .find({
        $or: [{ orderNumber: q }, { orderId: q }, { phoneNumber: q }],
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .exec();
    const data = rows.map((order) => this.toTrackingResponse(order));
    return { data, total: data.length };
  }

  async updateStatus(
    id: string,
    status: OrderStatus,
    statusNote?: string,
  ): Promise<OrderResponseDto | null> {
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

    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid order id.');
    }

    const update: Partial<Order> = hasCustomerFields
      ? this.buildCustomerInfoUpdate(customerFields)
      : {};

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

  async getSummary() {
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));

    const totalSalesToday = await this.orderModel.aggregate<AggregateTotal>([
      {
        $match: {
          status: { $in: ['paid', 'partial'] },
          createdAt: { $gte: startOfDay },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $eq: ['$status', 'partial'] },
                '$depositTotal',
                '$total',
              ],
            },
          },
        },
      },
    ]);

    const totalCashToday = await this.orderModel.aggregate<AggregateTotal>([
      {
        $match: {
          status: { $in: ['paid', 'partial'] },
          payment: 'cash',
          createdAt: { $gte: startOfDay },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $cond: [
                { $eq: ['$status', 'partial'] },
                '$depositTotal',
                '$total',
              ],
            },
          },
        },
      },
    ]);

    const totalPromptPayToday = await this.orderModel.aggregate<AggregateTotal>(
      [
        {
          $match: {
            status: { $in: ['paid', 'partial'] },
            payment: 'promptpay',
            createdAt: { $gte: startOfDay },
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'partial'] },
                  '$depositTotal',
                  '$total',
                ],
              },
            },
          },
        },
      ],
    );

    const completedCount = await this.orderModel.countDocuments({
      status: { $in: ['paid', 'partial'] },
      createdAt: { $gte: startOfDay },
    });

    return {
      salesToday: totalSalesToday[0]?.total ?? 0,
      cashToday: totalCashToday[0]?.total ?? 0,
      promptPayToday: totalPromptPayToday[0]?.total ?? 0,
      completed: completedCount,
    };
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

    order.depositTotal += amount;
    order.paidAmount = (order.paidAmount ?? 0) + amount;
    order.remainingTotal = Math.max(0, order.grandTotal - order.paidAmount);
    order.payments.push({ amount, method, note, paidAt: new Date() });
    order.status = order.remainingTotal === 0 ? 'paid' : 'awaiting_payment';
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
  ): Promise<Record<string, unknown> | null> {
    const order = await this.orderModel
      .findOne({ $or: [{ orderNumber }, { orderId: orderNumber }] })
      .exec();
    return order ? this.toTrackingResponse(order) : null;
  }

  async searchTracking(query: {
    orderNumber?: string;
    phone?: string;
  }): Promise<{ data: Record<string, unknown>[]; total: number }> {
    const filter: Record<string, unknown> = {};
    const or: Record<string, unknown>[] = [];
    if (query.orderNumber?.trim()) {
      const value = query.orderNumber.trim();
      or.push({ orderNumber: value }, { orderId: value });
    }
    if (query.phone?.trim()) {
      filter.phoneNumber = query.phone.trim();
    }
    if (or.length) {
      filter.$or = or;
    }

    if (!Object.keys(filter).length) {
      throw new BadRequestException('orderNumber or phone is required.');
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
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid order id.');
    }

    const update = this.buildCustomerInfoUpdate(updateDto);

    const updated = await this.orderModel
      .findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .exec();

    if (!updated) {
      throw new NotFoundException(`Order not found for id "${id}".`);
    }

    return this.toOrderResponse(updated);
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

    if (Object.keys(update).length === 0) {
      throw new BadRequestException(
        'At least one customer field must be provided.',
      );
    }

    return update;
  }

  private resolveMirroredField(
    fieldName: 'taxId' | 'address',
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

  private normalizeOrderForCreate(orderDto: CreateOrderDto): Partial<Order> {
    const cart = (orderDto.cart ?? []).map((item) => {
      const qty = Number(item.qty ?? item.quantity);
      const unitPrice = Number(item.unitPrice ?? item.price);
      const totalPrice = Number(
        item.totalPrice ?? item.total ?? qty * unitPrice,
      );

      if (!Number.isFinite(qty) || qty <= 0) {
        throw new BadRequestException('Order item qty must be greater than 0.');
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new BadRequestException(
          'Order item unitPrice must be 0 or more.',
        );
      }
      if (!Number.isFinite(totalPrice) || totalPrice < 0) {
        throw new BadRequestException(
          'Order item totalPrice must be 0 or more.',
        );
      }

      return {
        ...item,
        qty,
        unitPrice,
        totalPrice,
      };
    });

    if (!cart.length) {
      throw new BadRequestException(
        'Order cart must contain at least one item.',
      );
    }

    const subtotal =
      orderDto.subtotal ??
      orderDto.total ??
      cart.reduce((sum, item) => sum + item.totalPrice, 0);
    const discount = orderDto.discount ?? 0;
    const grandTotal = orderDto.grandTotal ?? Math.max(0, subtotal - discount);
    const paidAmount = orderDto.paidAmount ?? orderDto.depositTotal ?? 0;
    const remainingTotal =
      orderDto.remainingTotal ?? Math.max(0, grandTotal - paidAmount);
    const payment = orderDto.paymentMethod ?? orderDto.payment ?? 'cash';

    for (const [field, value] of Object.entries({
      subtotal,
      discount,
      grandTotal,
      paidAmount,
      remainingTotal,
    })) {
      if (!Number.isFinite(value) || value < 0) {
        throw new BadRequestException(`${field} must be 0 or more.`);
      }
    }

    return {
      ...orderDto,
      customerName: orderDto.customerName ?? '',
      phoneNumber: orderDto.phoneNumber ?? orderDto.phone ?? '',
      note: orderDto.note ?? '',
      total: subtotal,
      subtotal,
      discount,
      grandTotal,
      depositTotal: paidAmount,
      paidAmount,
      remainingTotal,
      payment,
      paymentMethod: payment,
      taxInvoice: 'no',
      vatAmount: 0,
      cart,
    };
  }

  private toTrackingResponse(order: OrderDocument): Record<string, unknown> {
    const plain = order.toObject() as OrderPlainObject;
    const id = order._id.toString();

    return {
      _id: id,
      orderId: plain.orderId ?? id,
      orderNumber: plain.orderNumber,
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
        sides: item.sides,
        material: item.material,
        size: item.size,
        note: item.note ?? item.productNote,
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

    return {
      _id: order._id.toString(),
      clientDraftId: plain.clientDraftId,
      idempotencyKey: plain.idempotencyKey,
      orderId: plain.orderId ?? order._id.toString(),
      orderNumber: plain.orderNumber,
      customerName: plain.customerName,
      phoneNumber: plain.phoneNumber,
      email: plain.email,
      address: resolvedAddress,
      customerAddress: plain.customerAddress ?? resolvedAddress,
      taxId: resolvedTaxId,
      customerTaxId: plain.customerTaxId ?? resolvedTaxId,
      branch: plain.branch,
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
      payments: plain.payments,
      statusHistory: plain.statusHistory ?? [],
      cart: plain.cart,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
    };
  }
}
