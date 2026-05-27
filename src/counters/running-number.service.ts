import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Counter,
  CounterDocument,
  COUNTER_TYPE_ORDER,
} from './counters.schema';

@Injectable()
export class RunningNumberService {
  constructor(
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
  ) {}

  async generateOrderNumber(now: Date = new Date()): Promise<string> {
    const date = this.formatDate(now);
    const counter = await this.counterModel.findOneAndUpdate(
      { type: COUNTER_TYPE_ORDER, date },
      {
        $inc: { seq: 1 },
        $setOnInsert: { type: COUNTER_TYPE_ORDER, date },
      },
      {
        new: true,
        upsert: true,
      },
    );

    if (!counter) {
      throw new InternalServerErrorException(
        'Failed to generate order number.',
      );
    }

    return `ORD-${date}-${counter.seq.toString().padStart(4, '0')}`;
  }

  private formatDate(date: Date): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.ORDER_NUMBER_TIMEZONE ?? 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;

    if (!year || !month || !day) {
      throw new InternalServerErrorException(
        'Failed to format order number date.',
      );
    }

    return `${year}${month}${day}`;
  }
}
