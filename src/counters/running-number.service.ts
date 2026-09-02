import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import {
  Counter,
  CounterDocument,
  COUNTER_TYPE_ORDER,
  COUNTER_TYPE_QUOTATION,
  COUNTER_TYPE_TAX_INVOICE,
} from './counters.schema';
import {
  getTaxInvoiceBookSequence,
  getTaxInvoiceCounterPeriod,
} from './tax-invoice-numbering';

export type TaxInvoiceNumber = {
  invoiceNumber: string;
  bookNo: string;
  invoiceSequence: string;
  invoicePeriod: string;
};

export type QuotationNumber = {
  quotationNumber: string;
  quotationPeriod: string;
  quotationSequence: string;
};

@Injectable()
export class RunningNumberService {
  constructor(
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
  ) {}

  async generateOrderNumber(
    now: Date = new Date(),
    session?: ClientSession,
  ): Promise<string> {
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
        ...(session ? { session } : {}),
      },
    );

    if (!counter) {
      throw new InternalServerErrorException(
        'Failed to generate order number.',
      );
    }

    return `GD-${year}-${counter.seq.toString().padStart(6, '0')}`;
  }

  async generateQuotationNumber(
    issuedAt: Date = new Date(),
    session?: ClientSession,
  ): Promise<QuotationNumber> {
    const quotationPeriod = this.getBangkokPeriod(issuedAt);
    const counterPeriod = Number(quotationPeriod);
    const counter = await this.counterModel.findOneAndUpdate(
      { type: COUNTER_TYPE_QUOTATION, year: counterPeriod },
      {
        $inc: { seq: 1 },
        $setOnInsert: {
          type: COUNTER_TYPE_QUOTATION,
          year: counterPeriod,
        },
      },
      { new: true, upsert: true, ...(session ? { session } : {}) },
    );
    if (!counter) {
      throw new InternalServerErrorException(
        'Failed to generate quotation number.',
      );
    }
    if (counter.seq > 9999) {
      throw new InternalServerErrorException(
        `Quotation sequence exhausted for period ${quotationPeriod}.`,
      );
    }

    const quotationSequence = counter.seq.toString().padStart(4, '0');
    return {
      quotationNumber: `QT-${quotationPeriod}-${quotationSequence}`,
      quotationPeriod,
      quotationSequence,
    };
  }

  async generateTaxInvoiceNumber(
    issuedAt: Date = new Date(),
    session?: ClientSession,
  ): Promise<TaxInvoiceNumber> {
    const invoicePeriod = this.getBangkokPeriod(issuedAt);
    const counterPeriod = getTaxInvoiceCounterPeriod(invoicePeriod);
    const counter = await this.counterModel.findOneAndUpdate(
      { type: COUNTER_TYPE_TAX_INVOICE, year: counterPeriod },
      {
        $inc: { seq: 1 },
        $setOnInsert: {
          type: COUNTER_TYPE_TAX_INVOICE,
          year: counterPeriod,
        },
      },
      { new: true, upsert: true, ...(session ? { session } : {}) },
    );
    if (!counter) {
      throw new InternalServerErrorException(
        'Failed to generate tax invoice number.',
      );
    }

    const { bookNo, invoiceSequence } = getTaxInvoiceBookSequence(counter.seq);

    return {
      invoiceNumber: `INV-${invoicePeriod}-${bookNo}-${invoiceSequence}`,
      bookNo,
      invoiceSequence,
      invoicePeriod,
    };
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

  private getBangkokPeriod(date: Date): string {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: process.env.ORDER_NUMBER_TIMEZONE ?? 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;

    if (!year || !month) {
      throw new InternalServerErrorException(
        'Failed to format document number period.',
      );
    }

    return `${year}${month}`;
  }
}
