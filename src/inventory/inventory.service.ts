import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Connection, isValidObjectId, Model, Types } from 'mongoose';
import { AuthenticatedUser } from '../auth/auth.types';
import { StockItem, StockItemDocument } from './schemas/stock-item.schema';
import {
  StockMovement,
  StockMovementDocument,
  StockMovementType,
} from './schemas/stock-movement.schema';

type StockActor = Pick<AuthenticatedUser, 'id' | 'username'>;

export type CreateStockItemCommand = {
  code: string;
  name: string;
  unit: string;
  minimumLevel?: number;
};

export type UpdateStockItemCommand = {
  code?: string;
  name?: string;
  unit?: string;
  minimumLevel?: number;
  active?: boolean;
};

export type RecordStockMovementCommand = {
  type: StockMovementType;
  quantity: number;
  reason: string;
  idempotencyKey?: string;
  businessReference?: {
    type: string;
    id: string;
  };
  orderId?: string;
  orderNumber?: string;
  productionJobId?: string;
  reasonMetadata?: Record<string, unknown>;
  idempotencyScope?: 'actor' | 'global';
};

export type ListStockMovementsQuery = {
  page?: number;
  limit?: number;
  itemId?: string;
  type?: StockMovementType;
  from?: string;
  to?: string;
  referenceType?: string;
  referenceId?: string;
  q?: string;
};

const INBOUND_MOVEMENT_TYPES = new Set<StockMovementType>([
  'receive',
  'adjustment_in',
]);

@Injectable()
export class InventoryService {
  constructor(
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
    @InjectModel(StockMovement.name)
    private readonly stockMovementModel: Model<StockMovementDocument>,
    @InjectConnection() private readonly mongoConnection: Connection,
  ) {}

  async createStockItem(
    command: CreateStockItemCommand,
  ): Promise<StockItemDocument> {
    const code = command.code.trim().toUpperCase();
    const name = command.name.trim();
    const unit = command.unit.trim();
    const minimumLevel = command.minimumLevel ?? 0;

    if (!code || !name || !unit) {
      throw new BadRequestException('Stock code, name, and unit are required.');
    }
    if (!Number.isFinite(minimumLevel) || minimumLevel < 0) {
      throw new BadRequestException(
        'Minimum stock level must be zero or greater.',
      );
    }

    try {
      return await this.stockItemModel.create({
        code,
        name,
        unit,
        minimumLevel,
        onHand: 0,
        active: true,
      });
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        throw new ConflictException(
          `Stock item code "${code}" already exists.`,
        );
      }
      throw error;
    }
  }

  async listStockItems(
    q?: string,
    includeInactive = false,
  ): Promise<StockItemDocument[]> {
    const filter: Record<string, unknown> = {};
    if (!includeInactive) filter.active = { $ne: false };
    const search = q?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { code: { $regex: escaped, $options: 'i' } },
        { name: { $regex: escaped, $options: 'i' } },
        { unit: { $regex: escaped, $options: 'i' } },
      ];
    }
    return this.stockItemModel
      .find(filter)
      .sort({ active: -1, name: 1 })
      .exec();
  }

  async getStockOverview() {
    const [activeItems, recentMovements] = await Promise.all([
      this.stockItemModel
        .find({ active: { $ne: false } })
        .sort({ name: 1 })
        .lean()
        .exec(),
      this.stockMovementModel
        .find({})
        .sort({ occurredAt: -1, _id: -1 })
        .limit(20)
        .lean()
        .exec(),
    ]);

    const itemIds = [
      ...new Set(
        recentMovements.map((movement) => String(movement.stockItemId)),
      ),
    ];
    const movedItems = itemIds.length
      ? await this.stockItemModel
          .find({ _id: { $in: itemIds.map((id) => new Types.ObjectId(id)) } })
          .lean()
          .exec()
      : [];
    const itemById = new Map(
      movedItems.map((item) => [String(item._id), item]),
    );
    const recentlyMovedItems = itemIds.slice(0, 5).flatMap((id) => {
      const item = itemById.get(id);
      if (!item) return [];
      const movement = recentMovements.find(
        (entry) => String(entry.stockItemId) === id,
      );
      return [
        {
          item,
          lastMovementAt: movement?.occurredAt ?? null,
          lastMovementType: movement?.type ?? null,
        },
      ];
    });

    return {
      totalActiveItems: activeItems.length,
      lowStockCount: activeItems.filter(
        (item) => item.onHand <= item.minimumLevel,
      ).length,
      recentlyMovedItems,
    };
  }

  async listStockMovements(query: ListStockMovementsQuery) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const filter: Record<string, unknown> = {};

    if (query.itemId) {
      this.assertObjectId(query.itemId);
      filter.stockItemId = new Types.ObjectId(query.itemId);
    }
    if (query.type) filter.type = query.type;
    if (query.referenceType?.trim()) {
      filter.referenceType = query.referenceType.trim();
    }
    if (query.referenceId?.trim()) {
      filter.referenceId = query.referenceId.trim();
    }

    if (query.from || query.to) {
      const occurredAt: Record<string, Date> = {};
      if (query.from) occurredAt.$gte = new Date(query.from);
      if (query.to) occurredAt.$lte = new Date(query.to);
      filter.occurredAt = occurredAt;
    }

    const search = query.q?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };
      const matchingItems = await this.stockItemModel
        .find({ $or: [{ code: regex }, { name: regex }, { unit: regex }] })
        .select({ _id: 1 })
        .lean()
        .exec();
      filter.$or = [
        { reason: regex },
        { actorUsername: regex },
        { referenceType: regex },
        { referenceId: regex },
        { stockItemId: { $in: matchingItems.map((item) => item._id) } },
      ];
    }

    const [total, movements] = await Promise.all([
      this.stockMovementModel.countDocuments(filter).exec(),
      this.stockMovementModel
        .find(filter)
        .sort({ occurredAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
    ]);

    const movementItemIds = [
      ...new Set(movements.map((movement) => String(movement.stockItemId))),
    ];
    const items = movementItemIds.length
      ? await this.stockItemModel
          .find({
            _id: { $in: movementItemIds.map((id) => new Types.ObjectId(id)) },
          })
          .lean()
          .exec()
      : [];
    const itemById = new Map(items.map((item) => [String(item._id), item]));

    return {
      items: movements.map((movement) => ({
        ...movement,
        stockItem: itemById.get(String(movement.stockItemId)) ?? null,
      })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getStockItem(id: string): Promise<StockItemDocument> {
    this.assertObjectId(id);
    const item = await this.stockItemModel.findById(id).exec();
    if (!item) throw new NotFoundException(`Stock item "${id}" not found.`);
    return item;
  }

  async updateStockItem(
    id: string,
    command: UpdateStockItemCommand,
  ): Promise<StockItemDocument> {
    this.assertObjectId(id);
    const update: Record<string, unknown> = {};
    if (command.code !== undefined)
      update.code = command.code.trim().toUpperCase();
    if (command.name !== undefined) update.name = command.name.trim();
    if (command.unit !== undefined) update.unit = command.unit.trim();
    if (command.minimumLevel !== undefined)
      update.minimumLevel = command.minimumLevel;
    if (command.active !== undefined) update.active = command.active;

    if ('code' in update && !update.code)
      throw new BadRequestException('Stock code is required.');
    if ('name' in update && !update.name)
      throw new BadRequestException('Stock name is required.');
    if ('unit' in update && !update.unit)
      throw new BadRequestException('Stock unit is required.');
    if (
      command.minimumLevel !== undefined &&
      (!Number.isFinite(command.minimumLevel) || command.minimumLevel < 0)
    ) {
      throw new BadRequestException(
        'Minimum stock level must be zero or greater.',
      );
    }

    try {
      const item = await this.stockItemModel
        .findByIdAndUpdate(
          id,
          { $set: update },
          { new: true, runValidators: true },
        )
        .exec();
      if (!item) throw new NotFoundException(`Stock item "${id}" not found.`);
      return item;
    } catch (error) {
      if (this.isDuplicateKey(error)) {
        const duplicateCode =
          typeof update.code === 'string' ? update.code : '';
        throw new ConflictException(
          `Stock item code "${duplicateCode}" already exists.`,
        );
      }
      throw error;
    }
  }

  async recordMovement(
    stockItemId: string,
    command: RecordStockMovementCommand,
    actor: StockActor,
  ): Promise<StockMovementDocument> {
    this.assertObjectId(stockItemId);
    const normalized = this.normalizeMovementCommand(command);
    const delta = this.resolveDelta(normalized.type, normalized.quantity);
    const fingerprint = this.buildMovementFingerprint(
      stockItemId,
      normalized,
      actor,
    );

    if (normalized.idempotencyKey) {
      const existing = await this.stockMovementModel
        .findOne({ idempotencyKey: normalized.idempotencyKey })
        .exec();
      if (existing) {
        this.assertIdempotentReplay(existing, fingerprint);
        return existing;
      }
    }

    try {
      return await this.mongoConnection.transaction(async (session) => {
        if (normalized.idempotencyKey) {
          const existing = await this.stockMovementModel
            .findOne({ idempotencyKey: normalized.idempotencyKey })
            .session(session)
            .exec();
          if (existing) {
            this.assertIdempotentReplay(existing, fingerprint);
            return existing;
          }
        }

        const itemFilter: Record<string, unknown> = {
          _id: stockItemId,
          active: { $ne: false },
        };
        if (delta < 0) {
          itemFilter.onHand = { $gte: Math.abs(delta) };
        }

        const updatedItem = await this.stockItemModel
          .findOneAndUpdate(
            itemFilter,
            { $inc: { onHand: delta } },
            { new: true, runValidators: true, session },
          )
          .exec();

        if (!updatedItem) {
          const item = await this.stockItemModel
            .findById(stockItemId)
            .session(session)
            .lean()
            .exec();
          if (!item) {
            throw new NotFoundException(
              `Stock item "${stockItemId}" not found.`,
            );
          }
          if (item.active === false) {
            throw new ConflictException(
              'Inactive stock items cannot be moved.',
            );
          }
          throw new ConflictException(
            'Stock movement would produce a negative on-hand balance.',
          );
        }

        const [movement] = await this.stockMovementModel.create(
          [
            {
              stockItemId,
              type: normalized.type,
              quantity: normalized.quantity,
              delta,
              balanceAfter: updatedItem.onHand,
              reason: normalized.reason,
              actorId: actor.id,
              actorUsername: actor.username,
              occurredAt: new Date(),
              referenceType: normalized.businessReference?.type,
              referenceId: normalized.businessReference?.id,
              orderId: normalized.orderId,
              orderNumber: normalized.orderNumber,
              productionJobId: normalized.productionJobId,
              reasonMetadata: normalized.reasonMetadata,
              idempotencyKey: normalized.idempotencyKey,
              commandFingerprint: fingerprint,
            },
          ],
          { session },
        );

        return movement;
      });
    } catch (error) {
      if (normalized.idempotencyKey && this.isDuplicateKey(error)) {
        const existing = await this.stockMovementModel
          .findOne({ idempotencyKey: normalized.idempotencyKey })
          .exec();
        if (existing) {
          this.assertIdempotentReplay(existing, fingerprint);
          return existing;
        }
      }
      throw error;
    }
  }

  private normalizeMovementCommand(
    command: RecordStockMovementCommand,
  ): RecordStockMovementCommand {
    if (!Number.isFinite(command.quantity) || command.quantity <= 0) {
      throw new BadRequestException(
        'Stock movement quantity must be positive.',
      );
    }

    const reason = command.reason.trim();
    if (!reason) {
      throw new BadRequestException('Stock movement reason is required.');
    }

    const idempotencyKey = command.idempotencyKey?.trim();
    if (idempotencyKey && idempotencyKey.length > 128) {
      throw new BadRequestException('Idempotency key is too long.');
    }

    const businessReference = command.businessReference
      ? {
          type: command.businessReference.type.trim(),
          id: command.businessReference.id.trim(),
        }
      : undefined;
    if (
      businessReference &&
      (!businessReference.type || !businessReference.id)
    ) {
      throw new BadRequestException(
        'Business reference type and id must both be provided.',
      );
    }

    const orderId = command.orderId?.trim() || undefined;
    const orderNumber = command.orderNumber?.trim() || undefined;
    const productionJobId = command.productionJobId?.trim() || undefined;

    return {
      ...command,
      reason,
      idempotencyKey: idempotencyKey || undefined,
      businessReference,
      orderId,
      orderNumber,
      productionJobId,
    };
  }

  private resolveDelta(type: StockMovementType, quantity: number): number {
    return INBOUND_MOVEMENT_TYPES.has(type) ? quantity : -quantity;
  }

  private buildMovementFingerprint(
    stockItemId: string,
    command: RecordStockMovementCommand,
    actor: StockActor,
  ): string {
    const hasExtendedContext = Boolean(
      command.orderId ||
        command.orderNumber ||
        command.productionJobId ||
        command.reasonMetadata ||
        command.idempotencyScope === 'global',
    );
    const payload = hasExtendedContext
      ? {
          fingerprintVersion: 2,
          idempotencyScope: command.idempotencyScope ?? 'actor',
          stockItemId,
          type: command.type,
          quantity: command.quantity,
          reason: command.reason,
          referenceType: command.businessReference?.type ?? null,
          referenceId: command.businessReference?.id ?? null,
          orderId: command.orderId ?? null,
          orderNumber: command.orderNumber ?? null,
          productionJobId: command.productionJobId ?? null,
          reasonMetadata: command.reasonMetadata ?? null,
          actorId: command.idempotencyScope === 'global' ? null : actor.id,
        }
      : {
          stockItemId,
          type: command.type,
          quantity: command.quantity,
          reason: command.reason,
          referenceType: command.businessReference?.type ?? null,
          referenceId: command.businessReference?.id ?? null,
          actorId: actor.id,
        };

    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  private assertIdempotentReplay(
    movement: Pick<StockMovement, 'commandFingerprint'>,
    fingerprint: string,
  ): void {
    if (movement.commandFingerprint !== fingerprint) {
      throw new ConflictException(
        'Idempotency key was already used for a different stock movement.',
      );
    }
  }

  private assertObjectId(id: string): void {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid stock item id.');
    }
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
