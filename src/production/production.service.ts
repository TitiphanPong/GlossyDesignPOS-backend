import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import { isValidObjectId, Model, PipelineStage, Types } from 'mongoose';
import { AuthenticatedUser } from '../auth/auth.types';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { InventoryService } from '../inventory/inventory.service';
import { PublicTrackingMilestone } from '../orders/dto/tracking-response.dto';
import { Order, OrderDocument } from '../orders/orders.schema';
import {
  MaterialRecipeComponent,
  Product,
  ProductDocument,
  ProductVariant,
} from '../products/product.schema';
import { Upload, UploadDocument } from '../uploads/schemas/upload.schema';
import {
  CreateProductionJobDto,
  ListProductionJobsQueryDto,
  UpdateProductionJobDto,
} from './dto/production-job.dto';
import {
  PRODUCTION_JOB_STAGES,
  ProductionJob,
  ProductionJobDocument,
  ProductionJobStage,
} from './schemas/production-job.schema';
import {
  COMPLETE_PRODUCTION_JOB_STAGES,
  bangkokProductionDayBounds,
  incompleteProductionJobMatch,
} from './production-urgency';

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const NEXT_STAGE: Partial<Record<ProductionJobStage, ProductionJobStage>> = {
  file_check: 'queued',
  queued: 'producing',
  producing: 'quality_check',
  quality_check: 'ready',
  ready: 'delivered',
};
const CUSTOMER_MILESTONE_BY_STAGE: Record<
  ProductionJobStage,
  PublicTrackingMilestone
> = {
  file_check: 'received',
  queued: 'received',
  producing: 'in_progress',
  quality_check: 'in_progress',
  ready: 'ready',
  delivered: 'completed',
};
const COMPLETE_STAGES = new Set<ProductionJobStage>(
  COMPLETE_PRODUCTION_JOB_STAGES,
);

type RecipeVariant = ProductVariant & {
  _id?: Types.ObjectId | string;
};

type ResolvedLineRecipe = {
  components: MaterialRecipeComponent[];
  source: 'product' | 'variant';
  variantId?: string;
};

type MaterialIssueContribution = {
  orderLineIndex: number;
  productId: string;
  productCode?: string;
  variantId?: string;
  lineName: string;
  lineQuantity: number;
  recipeSource: 'product' | 'variant';
  recipeQuantity: number;
  recipeUnit: string;
  conversionFactor?: number;
  stockUnit: string;
  issuedQuantity: number;
};

type MaterialIssueRequirement = {
  quantity: number;
  contributions: MaterialIssueContribution[];
};

@Injectable()
export class ProductionService {
  constructor(
    @InjectModel(ProductionJob.name)
    private readonly productionJobModel: Model<ProductionJobDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(Upload.name)
    private readonly uploadModel: Model<UploadDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly inventoryService: InventoryService,
  ) {}

  async createJob(
    dto: CreateProductionJobDto,
    actor: Pick<AuthenticatedUser, 'id'>,
  ) {
    this.assertObjectId(dto.orderId, 'order id');
    const order = await this.orderModel.findById(dto.orderId).exec();
    if (!order)
      throw new NotFoundException(`Order "${dto.orderId}" not found.`);

    const workSummary = dto.workSummary.trim();
    if (!workSummary)
      throw new BadRequestException('Work summary is required.');
    const dueAt = this.parseDueAt(dto.dueAt);
    const assignee = await this.resolveAssignee(dto.assigneeUserId);
    const linkedUploadIds = await this.validateLinkedUploads(
      dto.linkedUploadIds ?? [],
      dto.orderId,
    );
    const orderLineIndexes = this.validateOrderLineIndexes(
      dto.orderLineIndexes,
      order.cart.length,
    );
    await this.assertOrderLineIndexesAvailable(dto.orderId, orderLineIndexes);
    const orderNumber = order.orderNumber ?? order.orderId ?? String(order._id);
    const changedAt = new Date();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const created = await this.productionJobModel.create({
          jobNumber: this.generateJobNumber(changedAt),
          orderId: order._id,
          orderNumber,
          workSummary,
          jobType: dto.jobType?.trim() || undefined,
          dueAt,
          priority: dto.priority ?? 'normal',
          assigneeUserId: assignee?.id,
          assigneeUsername: assignee?.username,
          internalNote: dto.internalNote?.trim() || undefined,
          linkedUploadIds,
          orderLineIndexes,
          stage: 'file_check',
          stageHistory: [
            { stage: 'file_check', changedAt, changedBy: actor.id },
          ],
        });
        return this.toResponse(created);
      } catch (error) {
        if (this.isDuplicateKey(error) && attempt < 4) continue;
        throw error;
      }
    }

    throw new ConflictException(
      'Unable to allocate a unique production job number.',
    );
  }

  async listJobs(query: ListProductionJobsQueryDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const baseMatch: Record<string, unknown> = {};
    if (query.priority) baseMatch.priority = query.priority;
    if (query.jobType?.trim()) {
      const escapedJobType = query.jobType
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      baseMatch.jobType = { $regex: `^${escapedJobType}$`, $options: 'i' };
    }
    if (query.assigneeUserId) baseMatch.assigneeUserId = query.assigneeUserId;
    if (query.active === true)
      Object.assign(baseMatch, incompleteProductionJobMatch());

    if (query.due && query.due !== 'all') {
      const now = new Date();
      if (query.due === 'overdue') {
        baseMatch.dueAt = { $lt: now };
        baseMatch.stage = { $nin: ['ready', 'delivered'] };
      } else {
        const { start, end } = bangkokProductionDayBounds(now);
        baseMatch.dueAt = { $gte: start, $lt: end };
      }
    }

    const pipeline: PipelineStage[] = [];
    if (Object.keys(baseMatch).length) pipeline.push({ $match: baseMatch });

    const search = query.q?.trim();
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = { $regex: escaped, $options: 'i' };
      pipeline.push(
        {
          $lookup: {
            from: this.orderModel.collection.name,
            localField: 'orderId',
            foreignField: '_id',
            as: '_searchOrder',
            pipeline: [{ $project: { customerName: 1 } }],
          },
        },
        {
          $match: {
            $or: [
              { jobNumber: regex },
              { orderNumber: regex },
              { workSummary: regex },
              { jobType: regex },
              { assigneeUsername: regex },
              { '_searchOrder.customerName': regex },
            ],
          },
        },
        { $project: { _searchOrder: 0 } },
      );
    }

    const selectedStagePipeline: PipelineStage.Match[] = query.stage
      ? [{ $match: { stage: query.stage } }]
      : [];
    pipeline.push({
      $facet: {
        items: [
          ...selectedStagePipeline,
          { $sort: { priority: -1, dueAt: 1, createdAt: 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ],
        total: [...selectedStagePipeline, { $count: 'count' }],
        stageCounts: [{ $group: { _id: '$stage', count: { $sum: 1 } } }],
      },
    });

    const [result] = await this.productionJobModel.aggregate<{
      items: ProductionJobDocument[];
      total: Array<{ count: number }>;
      stageCounts: Array<{ _id: ProductionJobStage; count: number }>;
    }>(pipeline);
    const jobs = result?.items ?? [];
    const total = result?.total[0]?.count ?? 0;
    const stageCounts = Object.fromEntries(
      PRODUCTION_JOB_STAGES.map((stage) => [
        stage,
        result?.stageCounts.find((row) => row._id === stage)?.count ?? 0,
      ]),
    ) as Record<ProductionJobStage, number>;

    return {
      items: jobs.map((job) => this.toResponse(job)),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      stageCounts,
    };
  }

  async listOrderJobs(orderId: string) {
    this.assertObjectId(orderId, 'order id');
    const jobs = await this.productionJobModel
      .find({ orderId: new Types.ObjectId(orderId) })
      .sort({ createdAt: 1 })
      .exec();
    return jobs.map((job) => this.toResponse(job));
  }

  async listAssignees() {
    const users = await this.userModel
      .find({ active: true })
      .select({ username: 1 })
      .sort({ username: 1 })
      .lean()
      .exec();
    return users.map((user) => ({
      id: String(user._id),
      username: user.username,
    }));
  }

  async getJob(id: string) {
    this.assertObjectId(id, 'production job id');
    const job = await this.productionJobModel.findById(id).exec();
    if (!job) throw new NotFoundException(`Production job "${id}" not found.`);
    return this.toResponse(job);
  }

  async updateJob(id: string, dto: UpdateProductionJobDto) {
    this.assertObjectId(id, 'production job id');
    const current = await this.productionJobModel.findById(id).exec();
    if (!current)
      throw new NotFoundException(`Production job "${id}" not found.`);

    const update: Record<string, unknown> = {};
    if (dto.workSummary !== undefined) {
      const workSummary = dto.workSummary.trim();
      if (!workSummary)
        throw new BadRequestException('Work summary is required.');
      update.workSummary = workSummary;
    }
    if (dto.dueAt !== undefined) update.dueAt = this.parseDueAt(dto.dueAt);
    if (dto.jobType !== undefined)
      update.jobType = dto.jobType.trim() || undefined;
    if (dto.priority !== undefined) update.priority = dto.priority;
    if (dto.internalNote !== undefined)
      update.internalNote = dto.internalNote.trim() || undefined;
    if (dto.assigneeUserId !== undefined) {
      const assignee = await this.resolveAssignee(dto.assigneeUserId);
      update.assigneeUserId = assignee?.id;
      update.assigneeUsername = assignee?.username;
    }
    if (dto.linkedUploadIds !== undefined) {
      update.linkedUploadIds = await this.validateLinkedUploads(
        dto.linkedUploadIds,
        String(current.orderId),
      );
    }
    if (dto.orderLineIndexes !== undefined) {
      if (current.materialIssueStartedAt || current.materialIssuedAt) {
        throw new ConflictException(
          'Production job order line mapping cannot change after material issue has started.',
        );
      }
      const order = await this.orderModel.findById(current.orderId).exec();
      if (!order) {
        throw new NotFoundException(
          `Order "${String(current.orderId)}" not found.`,
        );
      }
      const orderLineIndexes = this.validateOrderLineIndexes(
        dto.orderLineIndexes,
        order.cart.length,
      );
      await this.assertOrderLineIndexesAvailable(
        current.orderId,
        orderLineIndexes,
        id,
      );
      update.orderLineIndexes = orderLineIndexes;
    }
    if (!Object.keys(update).length) {
      throw new BadRequestException(
        'At least one production job field is required.',
      );
    }

    const updateFilter: Record<string, unknown> = { _id: id };
    if (dto.orderLineIndexes !== undefined) {
      updateFilter.materialIssueStartedAt = { $exists: false };
      updateFilter.materialIssuedAt = { $exists: false };
    }
    const updated = await this.productionJobModel
      .findOneAndUpdate(
        updateFilter,
        { $set: update },
        { new: true, runValidators: true },
      )
      .exec();
    if (!updated) {
      if (dto.orderLineIndexes !== undefined) {
        const latest = await this.productionJobModel.findById(id).exec();
        if (latest) {
          throw new ConflictException(
            'Production job order line mapping cannot change after material issue has started.',
          );
        }
      }
      throw new NotFoundException(`Production job "${id}" not found.`);
    }
    return this.toResponse(updated);
  }

  async updateStage(
    id: string,
    target: ProductionJobStage,
    actor: Pick<AuthenticatedUser, 'id' | 'username'>,
  ) {
    this.assertObjectId(id, 'production job id');
    const current = await this.productionJobModel.findById(id).exec();
    if (!current)
      throw new NotFoundException(`Production job "${id}" not found.`);
    if (current.stage === target) return this.toResponse(current);

    const expected = NEXT_STAGE[current.stage];
    if (expected !== target) {
      throw new ConflictException(
        `Production job cannot transition from ${current.stage} to ${target}.`,
      );
    }

    if (current.stage === 'queued' && target === 'producing') {
      await this.issueJobMaterials(current, actor);
    }

    const changedAt = new Date();
    const updated = await this.productionJobModel
      .findOneAndUpdate(
        { _id: current._id, stage: current.stage },
        {
          $set: { stage: target },
          $push: {
            stageHistory: { stage: target, changedAt, changedBy: actor.id },
          },
        },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updated) {
      const latest = await this.productionJobModel.findById(id).exec();
      if (latest?.stage === target) return this.toResponse(latest);
      throw new ConflictException(
        'Production job changed concurrently. Refresh and retry.',
      );
    }
    return this.toResponse(updated);
  }

  private async issueJobMaterials(
    job: ProductionJobDocument,
    actor: Pick<AuthenticatedUser, 'id' | 'username'>,
  ): Promise<void> {
    if (job.materialIssuedAt) return;

    const order = await this.orderModel.findById(job.orderId).exec();
    if (!order) {
      throw new NotFoundException(`Order "${String(job.orderId)}" not found.`);
    }

    const explicitIndexes = job.orderLineIndexes ?? [];
    let lineIndexes = explicitIndexes;
    if (!lineIndexes.length) {
      const siblingCount = await this.productionJobModel
        .countDocuments({ orderId: job.orderId })
        .exec();
      if (
        siblingCount > 1 &&
        order.cart.some((line) => Boolean(line.productId))
      ) {
        throw new BadRequestException(
          'Multiple production jobs require explicit order line mapping before materials can be issued.',
        );
      }
      lineIndexes = order.cart.map((_, index) => index);
    }

    if (explicitIndexes.length) {
      await this.assertOrderLineIndexesAvailable(
        job.orderId,
        lineIndexes,
        String(job._id),
      );
    }

    const canonicalLines = lineIndexes.flatMap((orderLineIndex) => {
      const line = order.cart[orderLineIndex];
      if (!line?.productId) return [];
      return [
        {
          orderLineIndex,
          line: line as typeof line & { productId: string },
        },
      ];
    });
    if (!canonicalLines.length) {
      await this.markMaterialsIssued(job);
      return;
    }

    const productIds = [
      ...new Set(canonicalLines.map(({ line }) => line.productId)),
    ];
    for (const productId of productIds) {
      if (!isValidObjectId(productId)) {
        throw new BadRequestException(
          `Order contains invalid canonical product id "${productId}".`,
        );
      }
    }
    const products = await this.productModel
      .find({
        _id: { $in: productIds },
        active: { $ne: false },
        deletedAt: null,
      })
      .exec();
    const productById = new Map(
      products.map((product) => [String(product._id), product]),
    );

    const requirements = new Map<string, MaterialIssueRequirement>();
    for (const { orderLineIndex, line } of canonicalLines) {
      const product = productById.get(line.productId);
      if (!product) {
        throw new BadRequestException(
          `Canonical product "${line.productId}" is unavailable for material issue.`,
        );
      }
      const recipe = this.resolveLineRecipe(product, line);
      if (!recipe.components.length) {
        throw new BadRequestException(
          `Material recipe is missing for order line "${line.name}".`,
        );
      }
      for (const component of recipe.components) {
        const resolved = await this.resolveStockQuantity(component, line.qty);
        const current = requirements.get(component.stockItemId) ?? {
          quantity: 0,
          contributions: [],
        };
        current.quantity += resolved.quantity;
        current.contributions.push({
          orderLineIndex,
          productId: line.productId,
          productCode: line.productCode,
          variantId: recipe.variantId,
          lineName: line.name,
          lineQuantity: line.qty,
          recipeSource: recipe.source,
          recipeQuantity: component.quantity,
          recipeUnit: component.unit,
          conversionFactor: component.conversionFactor,
          stockUnit: resolved.stockUnit,
          issuedQuantity: resolved.quantity,
        });
        requirements.set(component.stockItemId, current);
      }
    }

    await this.lockMaterialIssue(job, explicitIndexes);

    for (const [stockItemId, requirement] of requirements) {
      await this.inventoryService.recordMovement(
        stockItemId,
        {
          type: 'issue',
          quantity: requirement.quantity,
          reason: `Production ${job.jobNumber} / Order ${job.orderNumber}`,
          idempotencyKey: `production-job:${String(job._id)}:issue:${stockItemId}`,
          idempotencyScope: 'global',
          businessReference: {
            type: 'production-job',
            id: String(job._id),
          },
          orderId: String(order._id),
          orderNumber: job.orderNumber,
          productionJobId: String(job._id),
          reasonMetadata: {
            triggerStage: 'producing',
            productionJobNumber: job.jobNumber,
            orderLineIndexes: lineIndexes,
            recipeSnapshot: requirement.contributions,
          },
        },
        actor,
      );
    }

    await this.markMaterialsIssued(job);
  }

  private resolveLineRecipe(
    product: ProductDocument,
    line: OrderDocument['cart'][number],
  ): ResolvedLineRecipe {
    const variantId = line.variant?.id ?? line.variant?._id;
    if (variantId) {
      const variant = (product.variants as RecipeVariant[]).find(
        (candidate) => String(candidate._id) === variantId,
      );
      if (!variant) {
        throw new BadRequestException(
          `Canonical variant "${variantId}" is unavailable for order line "${line.name}".`,
        );
      }
      if (variant.recipe?.length) {
        return { components: variant.recipe, source: 'variant', variantId };
      }
    }
    return {
      components: product.recipe ?? [],
      source: 'product',
      variantId: variantId || undefined,
    };
  }

  private async resolveStockQuantity(
    component: MaterialRecipeComponent,
    lineQuantity: number,
  ): Promise<{ quantity: number; stockUnit: string }> {
    const stockItem = await this.inventoryService.getStockItem(
      component.stockItemId,
    );
    if (stockItem.active === false) {
      throw new ConflictException(
        `Stock item "${component.stockItemId}" is inactive.`,
      );
    }
    const sameUnit =
      stockItem.unit.trim().toLowerCase() ===
      component.unit.trim().toLowerCase();
    if (!sameUnit && !component.conversionFactor) {
      throw new BadRequestException(
        `Recipe unit "${component.unit}" requires a conversion factor for stock unit "${stockItem.unit}".`,
      );
    }
    const factor = sameUnit ? 1 : (component.conversionFactor ?? 1);
    return {
      quantity: component.quantity * lineQuantity * factor,
      stockUnit: stockItem.unit,
    };
  }

  private async lockMaterialIssue(
    job: ProductionJobDocument,
    expectedOrderLineIndexes: number[],
  ): Promise<void> {
    if (job.materialIssuedAt || job.materialIssueStartedAt) return;

    const startedAt = new Date();
    const mappingFilter = expectedOrderLineIndexes.length
      ? { orderLineIndexes: expectedOrderLineIndexes }
      : {
          $or: [
            { orderLineIndexes: [] },
            { orderLineIndexes: { $exists: false } },
          ],
        };
    const locked = await this.productionJobModel
      .findOneAndUpdate(
        {
          _id: job._id,
          materialIssueStartedAt: { $exists: false },
          materialIssuedAt: { $exists: false },
          ...mappingFilter,
        },
        { $set: { materialIssueStartedAt: startedAt } },
        { new: true, runValidators: true },
      )
      .exec();

    if (locked) {
      job.materialIssueStartedAt = locked.materialIssueStartedAt ?? startedAt;
      return;
    }

    const latest = await this.productionJobModel.findById(job._id).exec();
    if (!latest) {
      throw new NotFoundException(
        `Production job "${String(job._id)}" not found.`,
      );
    }
    if (latest.materialIssuedAt) {
      job.materialIssueStartedAt = latest.materialIssueStartedAt;
      job.materialIssuedAt = latest.materialIssuedAt;
      return;
    }

    const latestIndexes = latest.orderLineIndexes ?? [];
    const sameMapping =
      latestIndexes.length === expectedOrderLineIndexes.length &&
      latestIndexes.every(
        (value, index) => value === expectedOrderLineIndexes[index],
      );
    if (latest.materialIssueStartedAt && sameMapping) {
      job.materialIssueStartedAt = latest.materialIssueStartedAt;
      return;
    }

    throw new ConflictException(
      'Production job order line mapping changed while material issue was starting. Refresh and retry.',
    );
  }

  private async markMaterialsIssued(job: ProductionJobDocument): Promise<void> {
    const issuedAt = new Date();
    await this.productionJobModel
      .findOneAndUpdate(
        { _id: job._id, materialIssuedAt: { $exists: false } },
        { $set: { materialIssuedAt: issuedAt } },
        { runValidators: true },
      )
      .exec();
    job.materialIssuedAt = issuedAt;
  }

  private validateOrderLineIndexes(
    indexes: number[] | undefined,
    lineCount: number,
  ): number[] {
    if (!indexes?.length) return [];
    const unique = [...new Set(indexes)];
    if (unique.some((index) => index < 0 || index >= lineCount)) {
      throw new BadRequestException(
        'Production job order line mapping is invalid.',
      );
    }
    return unique.sort((left, right) => left - right);
  }

  private async assertOrderLineIndexesAvailable(
    orderId: string | Types.ObjectId,
    indexes: number[],
    excludeJobId?: string,
  ): Promise<void> {
    if (!indexes.length) return;
    const filter: Record<string, unknown> = {
      orderId,
      orderLineIndexes: { $in: indexes },
    };
    if (excludeJobId) filter._id = { $ne: excludeJobId };
    const overlapping = await this.productionJobModel
      .findOne(filter)
      .select({ jobNumber: 1, orderLineIndexes: 1 })
      .lean()
      .exec();
    if (!overlapping) return;
    const overlap = (overlapping.orderLineIndexes ?? []).filter((index) =>
      indexes.includes(index),
    );
    throw new ConflictException(
      `Order line mapping overlaps production job ${overlapping.jobNumber ?? String(overlapping._id)} at line(s): ${overlap.map((index) => index + 1).join(', ')}.`,
    );
  }

  private async resolveAssignee(userId?: string) {
    const normalized = userId?.trim();
    if (!normalized) return undefined;
    this.assertObjectId(normalized, 'assignee user id');
    const user = await this.userModel
      .findOne({ _id: normalized, active: true })
      .select({ username: 1 })
      .lean()
      .exec();
    if (!user)
      throw new BadRequestException('Assignee must be an active staff user.');
    return { id: String(user._id), username: user.username };
  }

  private async validateLinkedUploads(uploadIds: string[], orderId: string) {
    const unique = [
      ...new Set(uploadIds.map((value) => value.trim()).filter(Boolean)),
    ];
    if (!unique.length) return [];
    const uploads = await this.uploadModel
      .find({ uploadId: { $in: unique } })
      .select({ uploadId: 1, linkedOrderId: 1 })
      .lean()
      .exec();
    const byId = new Map(uploads.map((upload) => [upload.uploadId, upload]));
    for (const uploadId of unique) {
      const upload = byId.get(uploadId);
      if (!upload)
        throw new BadRequestException(`Upload "${uploadId}" not found.`);
      if (upload.linkedOrderId !== orderId) {
        throw new BadRequestException(
          `Upload "${uploadId}" must be linked to the same Order first.`,
        );
      }
    }
    return unique;
  }

  private parseDueAt(value: string) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()))
      throw new BadRequestException('Invalid dueAt.');
    return parsed;
  }

  private formatBangkok(value: Date) {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(value);
  }

  private toResponse(job: ProductionJobDocument) {
    const now = new Date();
    return {
      id: String(job._id),
      jobNumber: job.jobNumber,
      orderId: String(job.orderId),
      orderNumber: job.orderNumber,
      workSummary: job.workSummary,
      jobType: job.jobType,
      dueAt: job.dueAt,
      dueAtBangkok: this.formatBangkok(job.dueAt),
      priority: job.priority,
      isRush: job.priority === 'rush',
      isOverdue:
        job.dueAt.getTime() < now.getTime() && !COMPLETE_STAGES.has(job.stage),
      assignee: job.assigneeUserId
        ? { id: job.assigneeUserId, username: job.assigneeUsername ?? '' }
        : null,
      internalNote: job.internalNote,
      linkedUploadIds: [...job.linkedUploadIds],
      orderLineIndexes: [...(job.orderLineIndexes ?? [])],
      materialIssuedAt: job.materialIssuedAt,
      stage: job.stage,
      customerMilestone: CUSTOMER_MILESTONE_BY_STAGE[job.stage],
      stageHistory: job.stageHistory.map((entry) => ({
        stage: entry.stage,
        changedAt: entry.changedAt,
        changedBy: entry.changedBy,
      })),
      createdAt: (job as ProductionJobDocument & { createdAt?: Date })
        .createdAt,
      updatedAt: (job as ProductionJobDocument & { updatedAt?: Date })
        .updatedAt,
    };
  }

  private generateJobNumber(now: Date) {
    const bangkok = new Date(now.getTime() + BANGKOK_OFFSET_MS);
    const y = bangkok.getUTCFullYear();
    const m = String(bangkok.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bangkok.getUTCDate()).padStart(2, '0');
    return `PJ-${y}${m}${d}-${randomBytes(4).toString('hex').toUpperCase()}`;
  }

  private assertObjectId(value: string, label: string) {
    if (!isValidObjectId(value))
      throw new BadRequestException(`Invalid ${label}.`);
  }

  private isDuplicateKey(error: unknown) {
    return error instanceof MongoServerError && error.code === 11000;
  }
}
