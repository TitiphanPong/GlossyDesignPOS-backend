import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Counter, CounterDocument } from './counters.schema';

@Injectable()
export class CounterService {
  constructor(@InjectModel(Counter.name) private counterModel: Model<CounterDocument>) {}

  async getNextOrderId(): Promise<string> {
    const result = await this.counterModel.findByIdAndUpdate(
      { _id: 'orderid' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );

    const padded = result.seq.toString().padStart(4, '0');
    return `OrderID${padded}`;
  }
}
