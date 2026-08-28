import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Connection, isValidObjectId, Model } from 'mongoose';
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

    return {
      ...command,
      reason,
      idempotencyKey: idempotencyKey || undefined,
      businessReference,
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
    return createHash('sha256')
      .update(
        JSON.stringify({
          stockItemId,
          type: command.type,
          quantity: command.quantity,
          reason: command.reason,
          referenceType: command.businessReference?.type ?? null,
          referenceId: command.businessReference?.id ?? null,
          actorId: actor.id,
        }),
      )
      .digest('hex');
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
