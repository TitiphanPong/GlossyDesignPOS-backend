import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MongoClient, ObjectId, type ClientSession } from 'mongodb';
import { splitPhoneNumbers } from '../src/customers/customer-import';
import {
  buildInvoiceCustomerReconciliationPlan,
  normalizeBranchNo,
  normalizeTaxId,
  type ReconciliationAction,
  type ReconciliationCustomer,
  type ReconciliationOrder,
} from '../src/customers/customer-reconciliation';

type RawCustomer = {
  _id: ObjectId;
  customerCode?: string;
  displayName?: string;
  phoneNumber?: string;
  phoneNumbers?: string[];
  email?: string;
  taxId?: string;
  companyName?: string;
  address?: string;
  branchType?: string;
  branchNo?: string;
  subDistrict?: string;
  district?: string;
  province?: string;
  postalCode?: string;
  shippingAddress?: string;
  active?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
};

type RawOrder = {
  _id: ObjectId;
  orderId?: string;
  orderNumber?: string;
  invoiceNumber?: string;
  customerId?: ObjectId;
  customerName?: string;
  companyName?: string;
  phoneNumber?: string;
  email?: string;
  customerEmail?: string;
  address?: string;
  customerAddress?: string;
  taxId?: string;
  customerTaxId?: string;
  branch?: string;
  customerBranch?: string;
  branchType?: string;
  branchNo?: string;
  subDistrict?: string;
  district?: string;
  province?: string;
  postalCode?: string;
  status?: string;
  saleDate?: Date;
  createdAt?: Date;
};

type PlannedCustomer = {
  identityKey: string;
  id: string;
  customerCode: string;
  sourceOrderId: string;
  sourceInvoiceNumber?: string;
  document: Omit<RawCustomer, '_id' | 'createdAt' | 'updatedAt'>;
  orderIds: string[];
};

type AppliedOrderLink = {
  orderId: string;
  orderNumber?: string;
  invoiceNumber?: string;
  previousCustomerId: string | null;
  customerId: string;
  source: 'existing' | 'created';
};

type ReconciliationReceipt = {
  version: 1;
  status: 'planned' | 'committed' | 'rolled_back';
  reconciliationId: string;
  databaseName: string;
  createdAt: string;
  committedAt?: string;
  rolledBackAt?: string;
  backupPath: string;
  planFingerprint: string;
  summary: Record<string, number>;
  createdCustomers: PlannedCustomer[];
  orderLinks: AppliedOrderLink[];
};

type ReconciliationSnapshot = {
  customers: RawCustomer[];
  orders: RawOrder[];
  plan: ReconciliationAction[];
};

function argumentValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function normalizedText(value?: string | null): string | undefined {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || undefined;
}

function normalizedAddress(value?: string | null): string {
  return String(value ?? '')
    .toLocaleLowerCase('th-TH')
    .replace(/\s+/g, '')
    .replace(/[,.]/g, '');
}

function toReconciliationCustomer(
  customer: RawCustomer,
): ReconciliationCustomer {
  return {
    id: customer._id.toHexString(),
    customerCode: customer.customerCode,
    displayName: customer.displayName,
    companyName: customer.companyName,
    taxId: customer.taxId,
    branchType: customer.branchType,
    branchNo: customer.branchNo,
    address: customer.address,
    active: customer.active,
  };
}

function toReconciliationOrder(order: RawOrder): ReconciliationOrder {
  return {
    id: order._id.toHexString(),
    orderNumber: order.orderNumber ?? order.orderId,
    invoiceNumber: order.invoiceNumber,
    customerId: order.customerId?.toHexString(),
    customerName: order.customerName,
    companyName: order.companyName,
    customerTaxId: order.customerTaxId,
    taxId: order.taxId,
    customerAddress: order.customerAddress,
    address: order.address,
    customerBranch: order.customerBranch,
    branch: order.branch,
    branchType: order.branchType,
    branchNo: order.branchNo,
    status: order.status,
  };
}

function actionSignature(
  action: ReconciliationAction,
): Record<string, unknown> {
  return {
    orderId: action.orderId,
    action: action.action,
    normalizedTaxId: action.normalizedTaxId ?? null,
    branchNo: action.branchNo ?? null,
    customerId: action.customerId ?? null,
    identityKey: action.identityKey ?? null,
    reason: action.reason,
  };
}

function planFingerprint(plan: ReconciliationAction[]): string {
  const stable = [...plan]
    .sort((a, b) => a.orderId.localeCompare(b.orderId))
    .map(actionSignature);
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function summarizePlan(plan: ReconciliationAction[]): Record<string, number> {
  return plan.reduce<Record<string, number>>((summary, action) => {
    summary[action.action] = (summary[action.action] ?? 0) + 1;
    return summary;
  }, {});
}

async function loadSnapshot(
  client: MongoClient,
  session?: ClientSession,
): Promise<ReconciliationSnapshot> {
  const database = client.db();
  const customers = await database
    .collection<RawCustomer>('customers')
    .find({}, { session })
    .toArray();
  const orders = await database
    .collection<RawOrder>('orders')
    .find({ invoiceNumber: { $type: 'string', $ne: '' } }, { session })
    .sort({ saleDate: 1, createdAt: 1, _id: 1 })
    .toArray();
  const plan = buildInvoiceCustomerReconciliationPlan(
    customers.map(toReconciliationCustomer),
    orders.map(toReconciliationOrder),
  );
  return { customers, orders, plan };
}

function latestOrder(orders: RawOrder[]): RawOrder {
  return [...orders].sort((a, b) => {
    const aTime = (a.saleDate ?? a.createdAt ?? new Date(0)).getTime();
    const bTime = (b.saleDate ?? b.createdAt ?? new Date(0)).getTime();
    if (aTime !== bTime) return bTime - aTime;
    return b._id.toHexString().localeCompare(a._id.toHexString());
  })[0];
}

function branchTypeFor(branchNo?: string, source?: string): string | undefined {
  const explicit = normalizedText(source);
  if (explicit) return explicit;
  if (branchNo === '00000') return 'สำนักงานใหญ่';
  if (branchNo) return `สาขาที่ ${branchNo}`;
  return undefined;
}

function buildCustomerDocument(
  order: RawOrder,
  normalizedTaxId: string,
  branchNo: string | undefined,
  customerCode: string,
): Omit<RawCustomer, '_id' | 'createdAt' | 'updatedAt'> {
  const displayName = normalizedText(order.customerName ?? order.companyName);
  if (!displayName) {
    throw new Error(
      `Cannot create Customer for invoice ${order.invoiceNumber ?? order._id.toHexString()}: customer name is empty.`,
    );
  }
  const rawPhone = normalizedText(order.phoneNumber);
  const phoneNumbers = rawPhone ? splitPhoneNumbers(rawPhone) : [];
  return {
    customerCode,
    displayName,
    companyName: normalizedText(order.companyName) ?? displayName,
    taxId: normalizedTaxId,
    ...(phoneNumbers[0] ? { phoneNumber: phoneNumbers[0] } : {}),
    phoneNumbers,
    ...(normalizedText(order.customerEmail ?? order.email)
      ? { email: normalizedText(order.customerEmail ?? order.email) }
      : {}),
    ...(normalizedText(order.customerAddress ?? order.address)
      ? { address: normalizedText(order.customerAddress ?? order.address) }
      : {}),
    ...(branchNo ? { branchNo } : {}),
    ...(branchTypeFor(
      branchNo,
      order.branchType ?? order.customerBranch ?? order.branch,
    )
      ? {
          branchType: branchTypeFor(
            branchNo,
            order.branchType ?? order.customerBranch ?? order.branch,
          ),
        }
      : {}),
    ...(normalizedText(order.subDistrict)
      ? { subDistrict: normalizedText(order.subDistrict) }
      : {}),
    ...(normalizedText(order.district)
      ? { district: normalizedText(order.district) }
      : {}),
    ...(normalizedText(order.province)
      ? { province: normalizedText(order.province) }
      : {}),
    ...(normalizedText(order.postalCode)
      ? { postalCode: normalizedText(order.postalCode) }
      : {}),
    active: true,
  };
}

function allocateCustomerCode(existingCodes: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = `CUS-${randomBytes(5).toString('hex').toUpperCase()}`;
    if (!existingCodes.has(code)) {
      existingCodes.add(code);
      return code;
    }
  }
  throw new Error('Failed to allocate a unique Customer code.');
}

function prepareCreatedCustomers(snapshot: ReconciliationSnapshot): {
  customers: PlannedCustomer[];
  reviewOrderIds: Set<string>;
} {
  const ordersById = new Map(
    snapshot.orders.map((order) => [order._id.toHexString(), order]),
  );
  const groups = new Map<string, ReconciliationAction[]>();
  for (const action of snapshot.plan) {
    if (action.action !== 'create_customer' || !action.identityKey) continue;
    const group = groups.get(action.identityKey) ?? [];
    group.push(action);
    groups.set(action.identityKey, group);
  }

  const existingCodes = new Set(
    snapshot.customers
      .map((customer) => customer.customerCode)
      .filter((code): code is string => Boolean(code)),
  );
  const reviewOrderIds = new Set<string>();
  const planned: PlannedCustomer[] = [];

  for (const [identityKey, actions] of groups) {
    const sourceOrders = actions
      .map((action) => ordersById.get(action.orderId))
      .filter((order): order is RawOrder => Boolean(order));
    if (sourceOrders.length !== actions.length) {
      throw new Error(`Missing Order while preparing identity ${identityKey}.`);
    }

    const branchNo = actions[0].branchNo;
    if (!branchNo && sourceOrders.length > 1) {
      const addresses = new Set(
        sourceOrders
          .map((order) =>
            normalizedAddress(order.customerAddress ?? order.address),
          )
          .filter(Boolean),
      );
      if (addresses.size > 1) {
        for (const action of actions) reviewOrderIds.add(action.orderId);
        continue;
      }
    }

    const source = latestOrder(sourceOrders);
    const normalizedTaxId = actions[0].normalizedTaxId;
    if (!normalizedTaxId) {
      throw new Error(`Missing normalized Tax ID for identity ${identityKey}.`);
    }
    const customerCode = allocateCustomerCode(existingCodes);
    planned.push({
      identityKey,
      id: new ObjectId().toHexString(),
      customerCode,
      sourceOrderId: source._id.toHexString(),
      sourceInvoiceNumber: source.invoiceNumber,
      document: buildCustomerDocument(
        source,
        normalizedTaxId,
        branchNo,
        customerCode,
      ),
      orderIds: actions.map((action) => action.orderId),
    });
  }

  return { customers: planned, reviewOrderIds };
}

function buildOrderLinks(
  snapshot: ReconciliationSnapshot,
  createdCustomers: PlannedCustomer[],
  reviewOrderIds: Set<string>,
): AppliedOrderLink[] {
  const createdByIdentity = new Map(
    createdCustomers.map((customer) => [customer.identityKey, customer]),
  );
  const links: AppliedOrderLink[] = [];

  for (const action of snapshot.plan) {
    if (reviewOrderIds.has(action.orderId)) continue;
    if (action.action === 'link_existing' && action.customerId) {
      links.push({
        orderId: action.orderId,
        orderNumber: action.orderNumber,
        invoiceNumber: action.invoiceNumber,
        previousCustomerId: null,
        customerId: action.customerId,
        source: 'existing',
      });
      continue;
    }
    if (action.action === 'create_customer' && action.identityKey) {
      const customer = createdByIdentity.get(action.identityKey);
      if (!customer) continue;
      links.push({
        orderId: action.orderId,
        orderNumber: action.orderNumber,
        invoiceNumber: action.invoiceNumber,
        previousCustomerId: null,
        customerId: customer.id,
        source: 'created',
      });
    }
  }

  return links;
}

function printDryRun(
  snapshot: ReconciliationSnapshot,
  createdCustomers: PlannedCustomer[],
  reviewOrderIds: Set<string>,
  links: AppliedOrderLink[],
): void {
  const planSummary = summarizePlan(snapshot.plan);
  const effectiveReview = (planSummary.review ?? 0) + reviewOrderIds.size;
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'dry-run',
        database: 'current MONGODB_URI database',
        invoiceOrders: snapshot.orders.length,
        plan: planSummary,
        effectiveReview,
        customersToCreate: createdCustomers.length,
        ordersToLink: links.length,
        createdCustomers: createdCustomers.map((customer) => ({
          identityKey: customer.identityKey,
          customerCode: customer.customerCode,
          displayName: customer.document.displayName,
          taxId: customer.document.taxId,
          branchNo: customer.document.branchNo ?? null,
          sourceInvoiceNumber: customer.sourceInvoiceNumber ?? null,
          orderCount: customer.orderIds.length,
        })),
        review: snapshot.plan
          .filter(
            (action) =>
              action.action === 'review' || reviewOrderIds.has(action.orderId),
          )
          .map(actionSignature),
      },
      null,
      2,
    )}\n`,
  );
}

async function applyReconciliation(
  client: MongoClient,
  backupDirectory: string,
): Promise<void> {
  const database = client.db();
  const snapshot = await loadSnapshot(client);
  const prepared = prepareCreatedCustomers(snapshot);
  const links = buildOrderLinks(
    snapshot,
    prepared.customers,
    prepared.reviewOrderIds,
  );
  printDryRun(snapshot, prepared.customers, prepared.reviewOrderIds, links);

  const timestamp = timestampForFile();
  await mkdir(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `invoice-customer-reconciliation-backup-${timestamp}.json`,
  );
  const receiptPath = path.join(
    backupDirectory,
    `invoice-customer-reconciliation-receipt-${timestamp}.json`,
  );
  const linkedOrderIds = new Set(links.map((link) => link.orderId));
  const existingCustomerIds = new Set(
    links
      .filter((link) => link.source === 'existing')
      .map((link) => link.customerId),
  );
  const backup = {
    version: 1,
    databaseName: database.databaseName,
    createdAt: new Date().toISOString(),
    orders: snapshot.orders.filter((order) =>
      linkedOrderIds.has(order._id.toHexString()),
    ),
    existingCustomers: snapshot.customers.filter((customer) =>
      existingCustomerIds.has(customer._id.toHexString()),
    ),
  };
  await writeFile(backupPath, `${JSON.stringify(backup, null, 2)}\n`, {
    flag: 'wx',
  });

  const receipt: ReconciliationReceipt = {
    version: 1,
    status: 'planned',
    reconciliationId: randomUUID(),
    databaseName: database.databaseName,
    createdAt: new Date().toISOString(),
    backupPath,
    planFingerprint: planFingerprint(snapshot.plan),
    summary: summarizePlan(snapshot.plan),
    createdCustomers: prepared.customers,
    orderLinks: links,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const fresh = await loadSnapshot(client, session);
      if (planFingerprint(fresh.plan) !== receipt.planFingerprint) {
        throw new Error(
          'Reconciliation plan changed after backup; no database writes were applied. Run dry-run again.',
        );
      }
      const freshPrepared = prepareCreatedCustomers(fresh);
      const preparedShape = prepared.customers
        .map((customer) => ({
          identityKey: customer.identityKey,
          orderIds: [...customer.orderIds].sort(),
        }))
        .sort((a, b) => a.identityKey.localeCompare(b.identityKey));
      const freshShape = freshPrepared.customers
        .map((customer) => ({
          identityKey: customer.identityKey,
          orderIds: [...customer.orderIds].sort(),
        }))
        .sort((a, b) => a.identityKey.localeCompare(b.identityKey));
      if (JSON.stringify(preparedShape) !== JSON.stringify(freshShape)) {
        throw new Error(
          'Missing-customer grouping changed after backup; no database writes were applied.',
        );
      }

      const customersCollection = database.collection<RawCustomer>('customers');
      const ordersCollection = database.collection<RawOrder>('orders');
      const now = new Date();
      if (prepared.customers.length > 0) {
        await customersCollection.insertMany(
          prepared.customers.map((customer) => ({
            _id: new ObjectId(customer.id),
            ...customer.document,
            createdAt: now,
            updatedAt: now,
          })),
          { ordered: true, session },
        );
      }

      for (const link of links) {
        const result = await ordersCollection.updateOne(
          {
            _id: new ObjectId(link.orderId),
            customerId: { $exists: false },
          },
          { $set: { customerId: new ObjectId(link.customerId) } },
          { session },
        );
        if (result.modifiedCount !== 1) {
          throw new Error(
            `Order ${link.orderNumber ?? link.orderId} changed before customer linkage; transaction aborted.`,
          );
        }
      }

      await database.collection('auditevents').insertOne(
        {
          actorUsername: 'customer-reconciliation',
          action: 'customer.invoice_reconciliation',
          targetType: 'customer-reconciliation',
          targetId: receipt.reconciliationId,
          metadata: {
            createdCustomers: prepared.customers.length,
            linkedOrders: links.length,
            reviewOrders:
              (receipt.summary.review ?? 0) + prepared.reviewOrderIds.size,
            receiptPath,
          },
          createdAt: now,
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  receipt.status = 'committed';
  receipt.committedAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'commit',
        reconciliationId: receipt.reconciliationId,
        createdCustomers: receipt.createdCustomers.length,
        linkedOrders: receipt.orderLinks.length,
        backupPath,
        receiptPath,
        rollbackCommand: `node --env-file=.env.development -r ts-node/register scripts/reconcile-invoice-customers.ts --rollback=${JSON.stringify(receiptPath)} --commit`,
      },
      null,
      2,
    )}\n`,
  );
}

async function rollbackReconciliation(
  client: MongoClient,
  receiptPath: string,
): Promise<void> {
  const receipt = JSON.parse(
    await readFile(receiptPath, 'utf8'),
  ) as ReconciliationReceipt;
  if (receipt.version !== 1 || receipt.status !== 'committed') {
    throw new Error(
      'Only a committed version-1 reconciliation receipt can roll back.',
    );
  }
  const database = client.db();
  if (database.databaseName !== receipt.databaseName) {
    throw new Error(
      `Receipt targets ${receipt.databaseName}, but current database is ${database.databaseName}.`,
    );
  }

  const createdCustomerIds = receipt.createdCustomers.map(
    (customer) => new ObjectId(customer.id),
  );
  const receiptOrderIds = new Set(
    receipt.orderLinks.map((link) => link.orderId),
  );
  const unexpectedOrders = await database
    .collection<RawOrder>('orders')
    .find({ customerId: { $in: createdCustomerIds } })
    .project({ _id: 1 })
    .toArray();
  const unexpectedOrderIds = unexpectedOrders
    .map((order) => order._id.toHexString())
    .filter((id) => !receiptOrderIds.has(id));
  const unexpectedQuotations = await database
    .collection('quotations')
    .countDocuments({ customerId: { $in: createdCustomerIds } });
  if (unexpectedOrderIds.length > 0 || unexpectedQuotations > 0) {
    throw new Error(
      `Rollback refused: created Customers gained unexpected references (${unexpectedOrderIds.length} Orders, ${unexpectedQuotations} Quotations).`,
    );
  }

  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const orders = database.collection<RawOrder>('orders');
      for (const link of receipt.orderLinks) {
        const current = await orders.findOne(
          { _id: new ObjectId(link.orderId) },
          { session, projection: { customerId: 1 } },
        );
        if (!current)
          throw new Error(`Rollback Order ${link.orderId} not found.`);
        if (current.customerId?.toHexString() !== link.customerId) {
          throw new Error(
            `Rollback refused: Order ${link.orderNumber ?? link.orderId} no longer points to the reconciled Customer.`,
          );
        }
        const update = link.previousCustomerId
          ? { $set: { customerId: new ObjectId(link.previousCustomerId) } }
          : { $unset: { customerId: '' as const } };
        await orders.updateOne({ _id: new ObjectId(link.orderId) }, update, {
          session,
        });
      }

      if (createdCustomerIds.length > 0) {
        const removed = await database.collection('customers').deleteMany(
          {
            _id: { $in: createdCustomerIds },
            customerCode: {
              $in: receipt.createdCustomers.map(
                (customer) => customer.customerCode,
              ),
            },
          },
          { session },
        );
        if (removed.deletedCount !== createdCustomerIds.length) {
          throw new Error(
            `Rollback removed ${removed.deletedCount}/${createdCustomerIds.length} created Customers; transaction aborted.`,
          );
        }
      }

      await database.collection('auditevents').insertOne(
        {
          actorUsername: 'customer-reconciliation',
          action: 'customer.invoice_reconciliation.rollback',
          targetType: 'customer-reconciliation',
          targetId: receipt.reconciliationId,
          metadata: {
            removedCustomers: createdCustomerIds.length,
            restoredOrders: receipt.orderLinks.length,
            receiptPath,
          },
          createdAt: new Date(),
        },
        { session },
      );
    });
  } finally {
    await session.endSession();
  }

  receipt.status = 'rolled_back';
  receipt.rolledBackAt = new Date().toISOString();
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        mode: 'rollback',
        reconciliationId: receipt.reconciliationId,
        removedCustomers: createdCustomerIds.length,
        restoredOrders: receipt.orderLinks.length,
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required.');
  const commit = process.argv.includes('--commit');
  const rollbackPath = argumentValue('--rollback');
  if (rollbackPath && !commit) {
    throw new Error('Rollback requires --commit.');
  }

  const client = new MongoClient(uri);
  await client.connect();
  try {
    if (rollbackPath) {
      await rollbackReconciliation(client, path.resolve(rollbackPath));
      return;
    }

    if (!commit) {
      const snapshot = await loadSnapshot(client);
      const prepared = prepareCreatedCustomers(snapshot);
      const links = buildOrderLinks(
        snapshot,
        prepared.customers,
        prepared.reviewOrderIds,
      );
      printDryRun(snapshot, prepared.customers, prepared.reviewOrderIds, links);
      return;
    }

    const backupDirectory = path.resolve(
      argumentValue('--backup-dir') ??
        path.join(process.cwd(), '..', 'backups'),
    );
    await applyReconciliation(client, backupDirectory);
  } finally {
    await client.close();
  }
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error
      ? error.message
      : 'Unexpected reconciliation failure.';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
