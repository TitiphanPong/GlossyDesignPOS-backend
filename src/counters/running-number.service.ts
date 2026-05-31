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
    const year = this.getYear(now);
    const counter = await this.counterModel.findOneAndUpdate(
      { type: COUNTER_TYPE_ORDER, year },
      {
        $inc: { seq: 1 },
        $setOnInsert: { type: COUNTER_TYPE_ORDER, year },
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

    return `GD-${year}-${counter.seq.toString().padStart(6, '0')}`;
  }

  private getYear(date: Date): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.ORDER_NUMBER_TIMEZONE ?? 'Asia/Bangkok',
      year: 'numeric',
    });

    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;

    if (!year) {
      throw new InternalServerErrorException(
        'Failed to format order number year.',
      );
    }

    return Number(year);
  }
}
