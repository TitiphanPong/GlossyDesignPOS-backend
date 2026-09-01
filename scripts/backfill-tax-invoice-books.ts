import { Collection, MongoClient, ObjectId } from 'mongodb';
import {
  getTaxInvoiceBookSequence,
  getTaxInvoiceCounterPeriod,
  INVOICES_PER_BOOK,
  TAX_INVOICE_CONTINUOUS_SEQUENCE_START_PERIOD,
} from '../src/counters/tax-invoice-numbering';

type LegacyTaxInvoice = {
  _id: ObjectId;
  saleDate?: Date;
  createdAt?: Date;
  bookNo?: string | null;
  invoiceSequence?: string | null;
  invoicePeriod?: string | null;
};

type StructuredTaxInvoice = {
  _id: ObjectId;
  bookNo: string;
  invoiceSequence: string;
  invoicePeriod: string;
};

type LegacyDateCounter = {
  _id: ObjectId;
  type: 'ORDER' | 'TAX_INVOICE';
  date: string;
  seq: number;
};

const TIME_ZONE = process.env.ORDER_NUMBER_TIMEZONE ?? 'Asia/Bangkok';

function getInvoicePeriod(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  if (!year || !month) {
    throw new Error('Could not determine tax invoice period.');
  }
  return `${year}${month}`;
}

async function normalizeLegacyDateCounters(
  counters: Collection,
): Promise<void> {
  const legacyDateCounters = (await counters
    .find({
      type: { $in: ['ORDER', 'TAX_INVOICE'] },
      date: { $type: 'string' },
      year: { $exists: false },
    })
    .toArray()) as LegacyDateCounter[];
  for (const counter of legacyDateCounters) {
    const period =
      counter.type === 'ORDER'
        ? counter.date.slice(0, 4)
        : counter.date.slice(0, 6);
    if (!/^\d{4}(\d{2})?$/.test(period)) {
      throw new TypeError(`Invalid legacy counter date ${counter.date}.`);
    }
    const counterPeriod =
      counter.type === 'TAX_INVOICE'
        ? getTaxInvoiceCounterPeriod(period)
        : Number(period);
    await counters.updateOne(
      { type: counter.type, year: counterPeriod },
      {
        $max: { seq: counter.seq },
        $setOnInsert: { type: counter.type, year: counterPeriod },
      },
      { upsert: true },
    );
  }
  if (legacyDateCounters.length > 0) {
    await counters.deleteMany({
      _id: { $in: legacyDateCounters.map((counter) => counter._id) },
    });
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is required.');
  }

  const client = new MongoClient(uri);
  await client.connect();

  try {
    const database = client.db();
    const orders = database.collection<LegacyTaxInvoice>('orders');
    const counters = database.collection('counters');
    const legacyOrders = await orders
      .find({
        taxInvoice: 'yes',
        $or: [
          { bookNo: { $exists: false } },
          { bookNo: null },
          { invoiceSequence: { $exists: false } },
          { invoiceSequence: null },
          { invoicePeriod: { $exists: false } },
          { invoicePeriod: null },
        ],
      })
      .sort({ saleDate: 1, createdAt: 1, _id: 1 })
      .toArray();
    const sequencesByCounterPeriod = new Map<number, number>();
    const updates = legacyOrders.map((order) => {
      const issuedAt = order.saleDate ?? order.createdAt;
      if (!issuedAt) {
        throw new Error(`Order ${order._id.toHexString()} has no issue date.`);
      }
      const invoicePeriod = getInvoicePeriod(issuedAt);
      const counterPeriod = getTaxInvoiceCounterPeriod(invoicePeriod);
      const totalSequence =
        (sequencesByCounterPeriod.get(counterPeriod) ?? 0) + 1;
      sequencesByCounterPeriod.set(counterPeriod, totalSequence);
      const { bookNo, invoiceSequence } =
        getTaxInvoiceBookSequence(totalSequence);

      return {
        updateOne: {
          filter: { _id: order._id },
          update: {
            $set: { bookNo, invoiceSequence, invoicePeriod },
          },
        },
      };
    });

    for (const counterPeriod of sequencesByCounterPeriod.keys()) {
      const structuredInvoices = await orders.countDocuments({
        taxInvoice: 'yes',
        invoicePeriod:
          counterPeriod === Number(TAX_INVOICE_CONTINUOUS_SEQUENCE_START_PERIOD)
            ? { $gte: TAX_INVOICE_CONTINUOUS_SEQUENCE_START_PERIOD }
            : counterPeriod.toString(),
        bookNo: { $exists: true, $ne: null },
        invoiceSequence: { $exists: true, $ne: null },
      });
      if (structuredInvoices > 0) {
        throw new Error(
          `Counter period ${counterPeriod} contains both legacy and structured tax invoices. Backfill must run before issuing new-format invoices for that counter period.`,
        );
      }
    }

    const summary = {
      mode: apply ? 'apply' : 'dry-run',
      legacyTaxInvoices: updates.length,
      counterPeriods: Object.fromEntries(sequencesByCounterPeriod),
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    if (!apply) {
      return;
    }

    if (updates.length > 0) {
      await orders.bulkWrite(updates, { ordered: true });
    }

    await normalizeLegacyDateCounters(counters);

    const counterIndexes = await counters.indexes();
    if (counterIndexes.some((index) => index.name === 'type_1_date_1')) {
      await counters.dropIndex('type_1_date_1');
    }
    await counters.createIndex({ type: 1, year: 1 }, { unique: true });

    const structuredInvoices = (await orders
      .find({
        taxInvoice: 'yes',
        bookNo: { $type: 'string' },
        invoiceSequence: { $type: 'string' },
        invoicePeriod: { $type: 'string' },
      })
      .toArray()) as StructuredTaxInvoice[];
    const maximumSequencesByCounterPeriod = new Map<number, number>();
    for (const invoice of structuredInvoices) {
      const bookNo = Number(invoice.bookNo);
      const invoiceSequence = Number(invoice.invoiceSequence);
      if (!Number.isInteger(bookNo) || !Number.isInteger(invoiceSequence)) {
        throw new TypeError(
          `Invalid book sequence on order ${invoice._id.toHexString()}.`,
        );
      }
      const totalSequence = (bookNo - 1) * INVOICES_PER_BOOK + invoiceSequence;
      const counterPeriod = getTaxInvoiceCounterPeriod(invoice.invoicePeriod);
      maximumSequencesByCounterPeriod.set(
        counterPeriod,
        Math.max(
          maximumSequencesByCounterPeriod.get(counterPeriod) ?? 0,
          totalSequence,
        ),
      );
    }
    await Promise.all(
      [...maximumSequencesByCounterPeriod].map(([counterPeriod, seq]) =>
        counters.updateOne(
          { type: 'TAX_INVOICE', year: counterPeriod },
          {
            $max: { seq },
            $setOnInsert: {
              type: 'TAX_INVOICE',
              year: counterPeriod,
            },
          },
          { upsert: true },
        ),
      ),
    );
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unexpected non-Error failure.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
