import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthenticatedUser } from './auth.types';
import { AuditEvent, AuditEventDocument } from './schemas/audit-event.schema';

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel(AuditEvent.name)
    private readonly auditModel: Model<AuditEventDocument>,
  ) {}

  /**
   * Persist an audit event without changing the outcome of the operation that
   * already completed. Audit storage is an observable best-effort sink, not a
   * transaction boundary for the business mutation.
   */
  async record(
    actor: AuthenticatedUser | null,
    action: string,
    target?: { type: string; id: string },
    metadata: Record<string, string | number | boolean | null> = {},
  ): Promise<boolean> {
    try {
      await this.auditModel.create({
        actorId: actor ? new Types.ObjectId(actor.id) : undefined,
        actorUsername: actor?.username ?? 'anonymous',
        action,
        targetType: target?.type,
        targetId: target?.id,
        metadata,
      });
      return true;
    } catch (error) {
      this.logger.error(
        `Failed to persist audit event "${action}"${target ? ` for ${target.type}:${target.id}` : ''}`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
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
