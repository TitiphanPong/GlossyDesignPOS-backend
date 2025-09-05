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
}
