/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { InventoryModule } from '../src/inventory/inventory.module';
import { OrdersModule } from '../src/orders/orders.module';
import { ProductModule } from '../src/products/product.module';
import { ProductionModule } from '../src/production/production.module';

jest.setTimeout(120_000);

const describeMongo =
  process.env.RUN_MONGO_INTEGRATION === '1' ? describe : describe.skip;

@Injectable()
class TestAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const requestContext = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      user?: { id: string; username: string; role: 'admin' };
    }>();
    if (requestContext.headers.authorization !== 'Bearer admin-token') {
      throw new UnauthorizedException();
    }
    requestContext.user = {
      id: '64b000000000000000000001',
      username: 'bom-e2e-admin',
      role: 'admin',
    };
    return true;
  }
}

describeMongo('Production BOM persisted contract (e2e)', () => {
  let replSet: MongoMemoryReplSet;
  let app: INestApplication;
  let server: Parameters<typeof request>[0];

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        MongooseModule.forRoot(replSet.getUri(), { dbName: 'glossy-bom-e2e' }),
        InventoryModule,
        ProductModule,
        OrdersModule,
        ProductionModule,
      ],
      providers: [{ provide: APP_GUARD, useClass: TestAuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();
    server = app.getHttpServer() as Parameters<typeof request>[0];
  });

  afterAll(async () => {
    await app?.close();
    await replSet?.stop();
  });

  const auth = { Authorization: 'Bearer admin-token' };

  async function createStock(code: string, onHand: number) {
    const created = await request(server)
      .post('/inventory/items')
      .set(auth)
      .send({ code, name: `${code} stock`, unit: 'sheet', minimumLevel: 0 })
      .expect(201);
    const itemId = String(created.body._id);
    if (onHand > 0) {
      await request(server)
        .post(`/inventory/items/${itemId}/movements`)
        .set(auth)
        .send({
          type: 'receive',
          quantity: onHand,
          reason: 'BOM E2E opening stock',
        })
        .expect(201);
    }
    return itemId;
  }

  async function createCatalogProduct(stockItemId: string, code: string) {
    const created = await request(server)
      .post('/products')
      .set(auth)
      .send({
        name: `${code} product`,
        code,
        category: 'BOM E2E',
        recipe: [{ stockItemId, quantity: 2, unit: 'sheet' }],
        variants: [{ name: 'Standard', price: 100 }],
      })
      .expect(201);
    const productId = String(created.body._id);
    const persisted = await request(server)
      .get(`/products/${productId}`)
      .set(auth)
      .expect(200);
    if (persisted.body.recipe?.[0]?.quantity !== 2) {
      throw new Error(
        `Unexpected persisted Product recipe: ${JSON.stringify(persisted.body.recipe)}`,
      );
    }
    return productId;
  }

  async function createOrder(productId: string) {
    const created = await request(server)
      .post('/orders')
      .set(auth)
      .set('Idempotency-Key', `bom-order-${productId}`)
      .send({
        customerName: 'BOM E2E customer',
        cart: [{ productId, quantity: 3 }],
      })
      .expect(201);
    const orderId = String(created.body._id);
    const persisted = await request(server)
      .get(`/orders/${orderId}`)
      .set(auth)
      .expect(200);
    if (persisted.body.cart?.[0]?.qty !== 3) {
      throw new Error(
        `Unexpected persisted Order line: ${JSON.stringify(persisted.body.cart?.[0])}`,
      );
    }
    return { id: orderId, orderNumber: String(created.body.orderNumber) };
  }

  async function createQueuedJob(orderId: string) {
    const created = await request(server)
      .post('/production/jobs')
      .set(auth)
      .send({
        orderId,
        workSummary: 'BOM persisted contract',
        dueAt: '2026-09-02T09:00:00.000Z',
        orderLineIndexes: [0],
      })
      .expect(201);
    const jobId = String(created.body.id);
    await request(server)
      .patch(`/production/jobs/${jobId}/stage`)
      .set(auth)
      .send({ stage: 'queued' })
      .expect(200);
    return { id: jobId, jobNumber: String(created.body.jobNumber) };
  }

  it('issues the exact recipe once and exposes persisted provenance through inventory history', async () => {
    const stockItemId = await createStock('BOM-PAPER-SUCCESS', 20);
    const productId = await createCatalogProduct(
      stockItemId,
      'BOM-PRODUCT-SUCCESS',
    );
    const order = await createOrder(productId);
    const job = await createQueuedJob(order.id);

    const producing = await request(server)
      .patch(`/production/jobs/${job.id}/stage`)
      .set(auth)
      .send({ stage: 'producing' });
    if (producing.status !== 200) {
      throw new Error(
        `Producing transition failed: ${JSON.stringify(producing.body)}`,
      );
    }

    const retry = await request(server)
      .patch(`/production/jobs/${job.id}/stage`)
      .set(auth)
      .send({ stage: 'producing' })
      .expect(200);
    expect(retry.body.stage).toBe('producing');

    const stock = await request(server)
      .get(`/inventory/items/${stockItemId}`)
      .set(auth)
      .expect(200);
    expect(stock.body.onHand).toBe(14);

    const movements = await request(server)
      .get('/inventory/movements?limit=100')
      .set(auth)
      .expect(200);
    const issueMovements = movements.body.items.filter(
      (movement: { type?: string; productionJobId?: string }) =>
        movement.type === 'issue' && movement.productionJobId === job.id,
    );
    expect(issueMovements).toHaveLength(1);
    const movement = issueMovements[0];
    expect(movement.quantity).toBe(6);
    expect(movement.delta).toBe(-6);
    expect(movement.orderId).toBe(order.id);
    expect(movement.orderNumber).toBe(order.orderNumber);
    expect(movement.productionJobId).toBe(job.id);
    expect(movement.referenceType).toBe('production-job');
    expect(movement.referenceId).toBe(job.id);
    expect(movement.reasonMetadata).toMatchObject({
      triggerStage: 'producing',
      productionJobNumber: job.jobNumber,
      orderLineIndexes: [0],
      recipeSnapshot: [
        {
          orderLineIndex: 0,
          productId,
          lineQuantity: 3,
          recipeSource: 'product',
          recipeQuantity: 2,
          recipeUnit: 'sheet',
          stockUnit: 'sheet',
          issuedQuantity: 6,
        },
      ],
    });
  });

  it('fails closed on insufficient stock without recording an issue movement', async () => {
    const stockItemId = await createStock('BOM-PAPER-LOW', 5);
    const productId = await createCatalogProduct(
      stockItemId,
      'BOM-PRODUCT-LOW',
    );
    const order = await createOrder(productId);
    const job = await createQueuedJob(order.id);

    await request(server)
      .patch(`/production/jobs/${job.id}/stage`)
      .set(auth)
      .send({ stage: 'producing' })
      .expect(409);

    const stock = await request(server)
      .get(`/inventory/items/${stockItemId}`)
      .set(auth)
      .expect(200);
    expect(stock.body.onHand).toBe(5);

    const movements = await request(server)
      .get('/inventory/movements?limit=100')
      .set(auth)
      .expect(200);
    const issueMovements = movements.body.items.filter(
      (movement: { type?: string; productionJobId?: string }) =>
        movement.type === 'issue' && movement.productionJobId === job.id,
    );
    expect(issueMovements).toHaveLength(0);

    const persistedJob = await request(server)
      .get(`/production/jobs/${job.id}`)
      .set(auth)
      .expect(200);
    expect(persistedJob.body.stage).toBe('queued');
  });
});
