// src/orders/orders.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from './orders.schema';
import { CounterService } from '../counters/counter.service';
import { OrdersSseService } from './orders.sse.service';

type OrderStatus = 'pending' | 'partial' | 'paid' | 'cancelled';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    private counterService: CounterService,
    private ordersSse: OrdersSseService,
  ) {}

  async create(orderDto: Partial<Order>): Promise<Order> {
    const orderId = await this.counterService.getNextOrderId();
    const createdOrder = new this.orderModel({
      ...orderDto,
      orderId,
      status: orderDto.status ?? 'pending', // 👈 default เป็น pending
    });
    const saved = await createdOrder.save();

    // 👉 ส่ง plain object ออกไปให้ customer screen
    this.ordersSse.emitOrder(saved.toObject());

    return saved;
  }

  async findAll(): Promise<Order[]> {
    return this.orderModel.find().sort({ createdAt: -1 }).lean().exec();
  }

  // 👉 "ล่าสุดที่ active" = pending หรือ paid ที่อัปเดตล่าสุด
  async findLatestActive(): Promise<Order | null> {
    return this.orderModel
      .findOne({ status: { $in: ['pending', 'paid'] } })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();
  }

  // 👉 อัปเดตสถานะ แล้วส่ง SSE ด้วย
  async updateStatus(id: string, status: OrderStatus) {
    const updated = await this.orderModel
      .findByIdAndUpdate(id, { status }, { new: true })
      .lean()
      .exec();

    if (!updated) return null;

    if (status === 'pending') {
      this.ordersSse.emitOrder(updated);
    } else if (status === 'partial') {
      this.ordersSse.emitOrder(updated); // ✅ โชว์บนจอ customer ต่อ
    } else if (status === 'paid') {
      this.ordersSse.emitOrderAndAutoClear(updated, 7000);
    } else if (status === 'cancelled') {
      this.ordersSse.emitOrder(null);
    }

    return updated;
  }

  // ==== (ของเดิม) สรุปยอด ใช้ต่อได้เหมือนเดิม ====
  // ==== (แก้ไข getSummary) ====
  async getSummary() {
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));

    const totalSalesToday = await this.orderModel.aggregate([
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
                '$depositTotal', // partial → นับเฉพาะยอดที่ได้รับแล้ว
                '$total', // paid → นับเต็ม
              ],
            },
          },
        },
      },
    ]);

    const totalCashToday = await this.orderModel.aggregate([
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

    const totalPromptPayToday = await this.orderModel.aggregate([
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
    ]);

    // 👇 ตรงนี้แก้เพิ่ม filter เฉพาะ "วันนี้" ด้วย
    const completedCount = await this.orderModel.countDocuments({
      status: { $in: ['paid', 'partial'] }, // ✅ นับทั้ง paid + partial
      createdAt: { $gte: startOfDay },
    });

    return {
      salesToday: totalSalesToday[0]?.total ?? 0,
      cashToday: totalCashToday[0]?.total ?? 0,
      promptPayToday: totalPromptPayToday[0]?.total ?? 0,
      completed: completedCount,
    };
  }

  async findByOrderId(orderId: string) {
    return this.orderModel.findOne({ orderId }).exec();
  }

  async addPayment(id: string, amount: number, method: 'cash' | 'promptpay') {
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

    // แจ้ง SSE ไปยังหน้าลูกค้า
    if (order.status === 'paid') {
      this.ordersSse.emitOrderAndAutoClear(updated.toObject(), 7000);
    } else {
      this.ordersSse.emitOrder(updated.toObject());
    }

    return updated;
  }
}
