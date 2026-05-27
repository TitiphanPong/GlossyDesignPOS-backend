import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { MongoServerError } from 'mongodb';
import { Model } from 'mongoose';
import { RunningNumberService } from '../counters/running-number.service';
import { OrderResponseDto } from './dto/order-response.dto';
import {
  Order,
  OrderDocument,
  OrderStatus,
  PaymentMethod,
} from './orders.schema';
import { OrdersSseService } from './orders.sse.service';

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

  async create(orderDto: Partial<Order>): Promise<OrderResponseDto> {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const orderNumber =
          await this.runningNumberService.generateOrderNumber();
        const createdOrder = new this.orderModel({
          ...orderDto,
          orderNumber,
          status: orderDto.status ?? 'pending',
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
          throw new ConflictException(
            'Duplicate value violates a unique index.',
          );
        }

        throw error;
      }
    }

    throw new InternalServerErrorException('Failed to create order.');
  }

  async findAll(): Promise<Order[]> {
    return this.orderModel.find().sort({ createdAt: -1 }).lean().exec();
  }

  async findById(id: string): Promise<Order | null> {
    return this.orderModel.findById(id).lean().exec();
  }

  async findLatestActive(): Promise<Order | null> {
    return this.orderModel
      .findOne({ status: { $in: ['pending', 'paid'] } })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();
  }

  async updateStatus(id: string, status: OrderStatus) {
    const updated = await this.orderModel
      .findByIdAndUpdate(id, { status }, { new: true })
      .lean()
      .exec();

    if (!updated) return null;

    if (status === 'pending' || status === 'partial') {
      this.ordersSse.emitOrder(updated);
    } else if (status === 'paid') {
      this.ordersSse.emitOrderAndAutoClear(updated, 7000);
    } else if (status === 'cancelled') {
      this.ordersSse.emitOrder(null);
    }

    return updated;
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

  async findByOrderId(orderNumber: string) {
    return this.orderModel
      .findOne({
        $or: [{ orderNumber }, { orderId: orderNumber }],
      })
      .exec();
  }

  async addPayment(id: string, amount: number, method: PaymentMethod) {
    const order = await this.orderModel.findById(id);
    if (!order) throw new Error('Order not found');

    if (amount > order.remainingTotal) {
      amount = order.remainingTotal;
    }

    order.depositTotal += amount;
    order.remainingTotal = order.total - order.depositTotal;
    order.payments.push({ amount, method, paidAt: new Date() });
    order.status = order.remainingTotal === 0 ? 'paid' : 'partial';

    const updated = await order.save();

    if (order.status === 'paid') {
      this.ordersSse.emitOrderAndAutoClear(updated.toObject(), 7000);
    } else {
      this.ordersSse.emitOrder(updated.toObject());
    }

    return updated;
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

  private toOrderResponse(order: OrderDocument): OrderResponseDto {
    const plain = order.toObject() as OrderPlainObject;

    return {
      _id: order._id.toString(),
      orderId: plain.orderId ?? order._id.toString(),
      orderNumber: plain.orderNumber,
      customerName: plain.customerName,
      phoneNumber: plain.phoneNumber,
      note: plain.note,
      total: plain.total,
      discount: plain.discount,
      depositTotal: plain.depositTotal,
      remainingTotal: plain.remainingTotal,
      payment: plain.payment,
      status: plain.status,
      taxInvoice: plain.taxInvoice,
      vatAmount: plain.vatAmount,
      grandTotal: plain.grandTotal,
      payments: plain.payments,
      cart: plain.cart,
      createdAt: plain.createdAt,
      updatedAt: plain.updatedAt,
    };
  }
}
