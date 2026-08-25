import { Collection, MongoClient, ObjectId } from 'mongodb';

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

const INVOICES_PER_BOOK = 100;
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

function getSequenceFields(monthlySequence: number) {
  const bookNo = Math.floor((monthlySequence - 1) / INVOICES_PER_BOOK) + 1;
  const invoiceSequence = ((monthlySequence - 1) % INVOICES_PER_BOOK) + 1;
  return {
    bookNo: bookNo.toString().padStart(3, '0'),
    invoiceSequence: invoiceSequence.toString().padStart(3, '0'),
  };
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
    await counters.updateOne(
      { type: counter.type, year: Number(period) },
      {
        $max: { seq: counter.seq },
        $setOnInsert: { type: counter.type, year: Number(period) },
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
    const sequencesByPeriod = new Map<string, number>();
    const updates = legacyOrders.map((order) => {
      const issuedAt = order.saleDate ?? order.createdAt;
      if (!issuedAt) {
        throw new Error(`Order ${order._id.toHexString()} has no issue date.`);
      }
      const invoicePeriod = getInvoicePeriod(issuedAt);
      const monthlySequence = (sequencesByPeriod.get(invoicePeriod) ?? 0) + 1;
      sequencesByPeriod.set(invoicePeriod, monthlySequence);
      const { bookNo, invoiceSequence } = getSequenceFields(monthlySequence);

      return {
        updateOne: {
          filter: { _id: order._id },
          update: {
            $set: { bookNo, invoiceSequence, invoicePeriod },
          },
        },
      };
    });

    for (const invoicePeriod of sequencesByPeriod.keys()) {
      const structuredInvoices = await orders.countDocuments({
        taxInvoice: 'yes',
        invoicePeriod,
        bookNo: { $exists: true, $ne: null },
        invoiceSequence: { $exists: true, $ne: null },
      });
      if (structuredInvoices > 0) {
        throw new Error(
          `Period ${invoicePeriod} contains both legacy and structured tax invoices. Backfill must run before issuing new-format invoices for that period.`,
        );
      }
    }

    const summary = {
      mode: apply ? 'apply' : 'dry-run',
      legacyTaxInvoices: updates.length,
      periods: Object.fromEntries(sequencesByPeriod),
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
    const maximumSequencesByPeriod = new Map<string, number>();
    for (const invoice of structuredInvoices) {
      const bookNo = Number(invoice.bookNo);
      const invoiceSequence = Number(invoice.invoiceSequence);
      if (!Number.isInteger(bookNo) || !Number.isInteger(invoiceSequence)) {
        throw new TypeError(`Invalid book sequence on order ${invoice._id}.`);
      }
      const monthlySequence =
        (bookNo - 1) * INVOICES_PER_BOOK + invoiceSequence;
      maximumSequencesByPeriod.set(
        invoice.invoicePeriod,
        Math.max(
          maximumSequencesByPeriod.get(invoice.invoicePeriod) ?? 0,
          monthlySequence,
        ),
      );
    }
    await Promise.all(
      [...maximumSequencesByPeriod].map(([invoicePeriod, seq]) =>
        counters.updateOne(
          { type: 'TAX_INVOICE', year: Number(invoicePeriod) },
          {
            $max: { seq },
            $setOnInsert: {
              type: 'TAX_INVOICE',
              year: Number(invoicePeriod),
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
