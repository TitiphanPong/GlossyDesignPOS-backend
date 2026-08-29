import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import {
  customerIdentityKey,
  loadCustomerWorkbook,
  type CustomerImportDocument,
} from '../src/customers/customer-import';

type ExistingCustomer = Partial<CustomerImportDocument> & {
  _id: ObjectId;
  customerCode?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

type ImportReceipt = {
  version: 1;
  status: 'planned' | 'committed';
  importId: string;
  sourceFile: string;
  sourceSha256: string;
  databaseName: string;
  createdAt: string;
  inserted: Array<{ id: string; customerCode: string }>;
};

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inlineValue = process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
  if (inlineValue) return inlineValue;
  const argumentIndex = process.argv.indexOf(name);
  return argumentIndex >= 0 ? process.argv[argumentIndex + 1] : undefined;
}

function requireArgument(name: string): string {
  const value = argumentValue(name);
  if (!value) throw new TypeError(`${name}=... is required.`);
  return value;
}

function normalizedExistingIdentity(
  customer: ExistingCustomer,
): string | undefined {
  if (!customer.taxId) return undefined;
  return customerIdentityKey({
    taxId: customer.taxId,
    branchType: customer.branchType,
    address: customer.address,
  });
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function rollbackImport(
  client: MongoClient,
  receiptPath: string,
): Promise<void> {
  if (!process.argv.includes('--commit')) {
    throw new TypeError('Rollback is a dry-run unless --commit is provided.');
  }
  const receipt = JSON.parse(
    await readFile(receiptPath, 'utf8'),
  ) as ImportReceipt;
  if (
    receipt.version !== 1 ||
    !receipt.importId ||
    !Array.isArray(receipt.inserted)
  ) {
    throw new TypeError('Invalid customer import receipt.');
  }
  const database = client.db();
  if (database.databaseName !== receipt.databaseName) {
    throw new TypeError(
      `Receipt targets ${receipt.databaseName}, but current database is ${database.databaseName}.`,
    );
  }
  const customers = database.collection<ExistingCustomer>('customers');
  const targets = receipt.inserted.map((item) => ({
    _id: new ObjectId(item.id),
    customerCode: item.customerCode,
  }));
  const matching = await customers.countDocuments({ $or: targets });
  if (matching !== targets.length) {
    throw new Error(
      `Rollback safety check found ${matching}/${targets.length} matching customers.`,
    );
  }

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await customers.deleteMany({ $or: targets }, { session });
      await database.collection('auditevents').insertOne(
        {
          actorUsername: 'codex-import',
          action: 'customer.bulk_import.rollback',
          targetType: 'customer-import',
          targetId: receipt.importId,
          metadata: {
            importId: receipt.importId,
            deletedCustomers: targets.length,
          },
          createdAt: new Date(),
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }
  process.stdout.write(
    `${JSON.stringify({ mode: 'rollback', importId: receipt.importId, deletedCustomers: targets.length }, null, 2)}\n`,
  );
}

async function importCustomers(client: MongoClient): Promise<void> {
  const commit = process.argv.includes('--commit');
  const sourcePath = path.resolve(requireArgument('--source'));
  const backupDirectory = path.resolve(
    argumentValue('--backup-dir') ?? path.join(process.cwd(), '..', 'backups'),
  );
  const workbook = await loadCustomerWorkbook(sourcePath);
  const database = client.db();
  const customers = database.collection<ExistingCustomer>('customers');
  const existingCustomers = await customers.find({}).toArray();
  const existingByIdentity = new Map<string, ExistingCustomer>();
  const existingByCode = new Map<string, ExistingCustomer>();
  for (const customer of existingCustomers) {
    const identity = normalizedExistingIdentity(customer);
    if (identity) existingByIdentity.set(identity, customer);
    if (customer.customerCode)
      existingByCode.set(customer.customerCode, customer);
  }

  const skippedExisting: number[] = [];
  const rowsToInsert = workbook.readyRows.filter((row) => {
    if (existingByIdentity.has(row.identityKey)) {
      skippedExisting.push(row.sourceRow);
      return false;
    }
    const codeCollision = existingByCode.get(row.document.customerCode);
    if (codeCollision) {
      throw new Error(
        `Customer code collision for source row ${row.sourceRow}; import stopped without writes.`,
      );
    }
    return true;
  });

  const summary = {
    mode: commit ? 'commit' : 'dry-run',
    database: database.databaseName,
    sourceFile: path.basename(sourcePath),
    sourceSha256: workbook.sourceSha256,
    sourceRows: workbook.sourceRows,
    readyRows: workbook.readyRows.length,
    reviewRowsSkipped: workbook.reviewRows.length,
    existingRowsSkipped: skippedExisting.length,
    customersToInsert: rowsToInsert.length,
    customersWithMultiplePhones: rowsToInsert.filter(
      (row) => row.document.phoneNumbers.length > 1,
    ).length,
    customersWithoutPhones: rowsToInsert.filter(
      (row) => row.document.phoneNumbers.length === 0,
    ).length,
    customersWithoutEmail: rowsToInsert.filter((row) => !row.document.email)
      .length,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!commit || rowsToInsert.length === 0) return;

  await mkdir(backupDirectory, { recursive: true });
  const fileTimestamp = timestampForFile();
  const backupPath = path.join(
    backupDirectory,
    `customers-before-import-${fileTimestamp}.json`,
  );
  await writeFile(
    backupPath,
    `${JSON.stringify(existingCustomers, null, 2)}\n`,
    { flag: 'wx' },
  );

  const importId = randomUUID();
  const documents = rowsToInsert.map((row) => ({
    _id: new ObjectId(),
    ...row.document,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const receiptPath = path.join(
    backupDirectory,
    `customer-import-receipt-${fileTimestamp}.json`,
  );
  const receipt: ImportReceipt = {
    version: 1,
    status: 'planned',
    importId,
    sourceFile: path.basename(sourcePath),
    sourceSha256: workbook.sourceSha256,
    databaseName: database.databaseName,
    createdAt: new Date().toISOString(),
    inserted: documents.map((document) => ({
      id: document._id.toHexString(),
      customerCode: document.customerCode,
    })),
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await customers.insertMany(documents, { ordered: true, session });
      await database.collection('auditevents').insertOne(
        {
          actorUsername: 'codex-import',
          action: 'customer.bulk_import',
          targetType: 'customer-import',
          targetId: importId,
          metadata: {
            sourceFile: path.basename(sourcePath),
            sourceSha256: workbook.sourceSha256,
            insertedCustomers: documents.length,
            skippedReviewRows: workbook.reviewRows.length,
            skippedExistingRows: skippedExisting.length,
          },
          createdAt: new Date(),
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  await customers.createIndex({ phoneNumbers: 1 }, { name: 'phoneNumbers_1' });
  receipt.status = 'committed';
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const verification = {
    insertedCustomers: await customers.countDocuments({
      _id: { $in: documents.map((document) => document._id) },
    }),
    insertedWithMultiplePhones: await customers.countDocuments({
      _id: { $in: documents.map((document) => document._id) },
      'phoneNumbers.1': { $exists: true },
    }),
    backupPath,
    receiptPath,
    rollbackCommand: `node --env-file=.env.development -r ts-node/register scripts/import-customers.ts --rollback=${JSON.stringify(receiptPath)} --commit`,
  };
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required.');
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const rollbackPath = argumentValue('--rollback');
    if (rollbackPath) {
      await rollbackImport(client, path.resolve(rollbackPath));
    } else {
      await importCustomers(client);
    }
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : 'Unexpected import failure.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
