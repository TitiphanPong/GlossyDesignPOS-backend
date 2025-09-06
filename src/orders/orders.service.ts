import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Order, OrderDocument } from './orders.schema';
import { CounterService } from '../counters/counter.service';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name) private orderModel: Model<OrderDocument>,
    private counterService: CounterService,
  ) {}

  async create(orderDto: any): Promise<Order> {
    const orderId = await this.counterService.getNextOrderId();
    const createdOrder = new this.orderModel({
      ...orderDto,
      orderId,
    });
    return createdOrder.save();
  }

  async findAll(): Promise<Order[]> {
    return this.orderModel.find().sort({ createdAt: -1 }).exec();
  }

  async getSummary() {
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));

    // ยอดขายรวมวันนี้
    const totalSalesToday = await this.orderModel.aggregate([
      { $match: { status: 'paid', createdAt: { $gte: startOfDay } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);

    // ยอดขายเงินสด (cash) วันนี้
    const totalCashToday = await this.orderModel.aggregate([
      {
        $match: {
          status: 'paid',
          payment: 'cash',
          createdAt: { $gte: startOfDay },
        },
      },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);

    // ยอดขายโอน (promptpay) วันนี้
    const totalPromptPayToday = await this.orderModel.aggregate([
      {
        $match: {
          status: 'paid',
          payment: 'promptpay',
          createdAt: { $gte: startOfDay },
        },
      },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);

    // งานเสร็จสิ้นทั้งหมด
    const completedCount = await this.orderModel.countDocuments({
      status: 'paid',
    });

    return {
      salesToday: totalSalesToday[0]?.total ?? 0,
      cashToday: totalCashToday[0]?.total ?? 0,
      promptPayToday: totalPromptPayToday[0]?.total ?? 0,
      completed: completedCount,
    };
  }
}
