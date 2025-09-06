// src/orders/orders.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from './orders.schema';
import { CounterService } from '../counters/counter.service';
import { OrdersSseService } from './orders.sse.service';

type OrderStatus = 'pending' | 'paid' | 'cancelled';

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
    { $match: { status: 'paid', createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  const totalCashToday = await this.orderModel.aggregate([
    { $match: { status: 'paid', payment: 'cash', createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  const totalPromptPayToday = await this.orderModel.aggregate([
    { $match: { status: 'paid', payment: 'promptpay', createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  // 👇 ตรงนี้แก้เพิ่ม filter เฉพาะ "วันนี้" ด้วย
  const completedCount = await this.orderModel.countDocuments({
    status: 'paid',
    createdAt: { $gte: startOfDay },
  });

  return {
    salesToday: totalSalesToday[0]?.total ?? 0,
    cashToday: totalCashToday[0]?.total ?? 0,
    promptPayToday: totalPromptPayToday[0]?.total ?? 0,
    completed: completedCount,
  };
}

}
