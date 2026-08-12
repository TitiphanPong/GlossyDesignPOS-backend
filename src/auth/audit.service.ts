import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthenticatedUser } from './auth.types';
import { AuditEvent, AuditEventDocument } from './schemas/audit-event.schema';

@Injectable()
export class AuditService {
  constructor(
    @InjectModel(AuditEvent.name)
    private readonly auditModel: Model<AuditEventDocument>,
  ) {}

  async record(
    actor: AuthenticatedUser | null,
    action: string,
    target?: { type: string; id: string },
    metadata: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    await this.auditModel.create({
      actorId: actor ? new Types.ObjectId(actor.id) : undefined,
      actorUsername: actor?.username ?? 'anonymous',
      action,
      targetType: target?.type,
      targetId: target?.id,
      metadata,
    });
  }

  async list(limit = 100) {
    return this.auditModel
      .find()
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 200))
      .lean()
      .exec();
  }
}
