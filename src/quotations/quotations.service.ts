import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import {
  ClientSession,
  Connection,
  isValidObjectId,
  Model,
  Types,
} from 'mongoose';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { UserRole } from '../auth/auth.constants';
import { RunningNumberService } from '../counters/running-number.service';
import {
  Customer,
  CustomerDocument,
} from '../customers/schemas/customer.schema';
import { OrderItemDto, type OrderDiscountDto } from '../orders/dto/order.dto';
import {
  calculateOrderMoney,
  fromMinorUnits,
  toMinorUnits,
} from '../orders/order-money';
import {
  OrderPricingService,
  ResolvedOrderLine,
} from '../orders/order-pricing.service';
import { Order, OrderDocument } from '../orders/orders.schema';
import {
  ApproveQuotationDto,
  CancelQuotationDto,
  ConvertQuotationDto,
  CreateQuotationDto,
  QuotationCustomerSnapshotDto,
  QuotationItemRequestDto,
  RejectQuotationDto,
  UpdateQuotationDto,
  VersionedQuotationCommandDto,
} from './dto/quotation.dto';
import { ListQuotationsQueryDto } from './dto/list-quotations-query.dto';
import {
  Quotation,
  QuotationDocument,
  QuotationItem,
  QuotationRevisionSnapshot,
  QuotationStatus,
} from './quotation.schema';
import {
  assertQuotationTransition,
  getEffectiveQuotationStatus,
  normalizeQuotationRangeBoundary,
  normalizeQuotationValidUntil,
} from './quotation.domain';

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const VAT_RATE = 7;
const EXPIRING_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

type QuotationPlain = Quotation & {
  _id: Types.ObjectId;
  __v?: number;
  createdAt?: Date;
  updatedAt?: Date;
};

type QuotationMoney = {
  subtotal: number;
  discount: number;
  discountType?: 'amount' | 'percent';
  discountValue?: number;
  taxableAmount: number;
  vatRate: number;
  vatAmount: number;
  grandTotal: number;
  taxInvoiceRequested: boolean;
  currency: 'THB';
};

export type QuotationResponse = Omit<QuotationPlain, 'status' | '_id'> & {
  _id: string;
  status: QuotationStatus;
  storedStatus: QuotationStatus;
  version: number;
};

type ConversionConflict = {
  index: number;
  name: string;
  quotedUnitPrice: number;
  currentUnitPrice: number;
};

@Injectable()
export class QuotationsService {
  constructor(
    @InjectModel(Quotation.name)
    private readonly quotationModel: Model<QuotationDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    private readonly orderPricing: OrderPricingService,
    private readonly runningNumber: RunningNumberService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  async create(
    dto: CreateQuotationDto,
    actor: AuthenticatedUser,
  ): Promise<QuotationResponse> {
    const customer = await this.resolveCustomerSnapshot(
      dto.customerId,
      dto.customerSnapshot,
    );
    const items = dto.items
      ? await this.resolveRequestedItems(dto.items, actor)
      : [];
    const money = this.calculateQuotationMoney(
      items,
      dto.discount,
      dto.taxInvoiceRequested ?? false,
    );
    const now = new Date();
    const quotation = new this.quotationModel({
      revision: 0,
      status: 'DRAFT',
      createdBy: actor.id,
      updatedBy: actor.id,
      ...(customer.customerId ? { customerId: customer.customerId } : {}),
      customerSnapshot: customer.snapshot,
      items,
      ...money,
      ...(dto.validUntil
        ? { validUntil: normalizeQuotationValidUntil(dto.validUntil) }
        : {}),
      subject: dto.subject?.trim(),
      notes: dto.notes?.trim(),
      termsAndConditions: dto.termsAndConditions?.trim(),
      paymentTerms: dto.paymentTerms?.trim(),
      deliveryTerms: dto.deliveryTerms?.trim(),
      internalNote: dto.internalNote?.trim(),
      statusHistory: [
        {
          status: 'DRAFT',
          action: 'CREATE',
          actor: actor.id,
          timestamp: now,
          reason: this.auditReason('CREATE'),
        },
      ],
      revisionHistory: [],
    });
    return this.toResponse(await quotation.save());
  }

  async list(query: ListQuotationsQueryDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const now = new Date();
    const filter = this.buildListFilter(query, now);
    const sort = this.buildSort(query.sort);
    const [docs, total, summary] = await Promise.all([
      this.quotationModel
        .find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.quotationModel.countDocuments(filter),
      this.getSummary(now),
    ]);
    return {
      data: docs.map((doc) => this.toResponse(doc, now)),
      page,
      limit,
      total,
      summary,
    };
  }

  async findById(id: string): Promise<QuotationResponse> {
    const doc = await this.findDocument(id);
    return this.toResponse(doc);
  }

  async update(
    id: string,
    dto: UpdateQuotationDto,
    actor: AuthenticatedUser,
  ): Promise<QuotationResponse> {
    const doc = await this.findDocument(id);
    this.assertVersion(doc, dto.version);
    if (getEffectiveQuotationStatus(doc.status, doc.validUntil) !== 'DRAFT') {
      throw new ConflictException(
        'Only a Draft quotation can be edited. Create a revision first.',
      );
    }

    if (dto.customerId !== undefined || dto.customerSnapshot !== undefined) {
      const customer = await this.resolveCustomerSnapshot(
        dto.customerId ?? doc.customerId?.toString(),
        dto.customerSnapshot,
        doc.customerSnapshot,
      );
      doc.customerId = customer.customerId;
      doc.customerSnapshot = customer.snapshot;
    }

    let items = doc.items;
    if (dto.items !== undefined) {
      items = await this.resolveRequestedItems(dto.items, actor);
      doc.items = items;
    }

    const discount = dto.discount ?? this.readStoredDiscount(doc);
    const taxInvoiceRequested =
      dto.taxInvoiceRequested ?? doc.taxInvoiceRequested ?? false;
    if (
      dto.items !== undefined ||
      dto.discount !== undefined ||
      dto.taxInvoiceRequested !== undefined
    ) {
      Object.assign(
        doc,
        this.calculateQuotationMoney(items, discount, taxInvoiceRequested),
      );
    }

    if (dto.validUntil !== undefined) {
      doc.validUntil = normalizeQuotationValidUntil(dto.validUntil);
    }
    this.assignOptionalDocumentFields(doc, dto);
    doc.updatedBy = actor.id;

    try {
      return this.toResponse(await doc.save());
    } catch (error) {
      this.rethrowConcurrency(error);
    }
  }

  async send(
    id: string,
    dto: VersionedQuotationCommandDto,
    actor: AuthenticatedUser,
  ): Promise<QuotationResponse> {
    const result = await this.connection.transaction(async (session) => {
      const doc = await this.findDocument(id, session);
      this.assertVersion(doc, dto.version);
      const effective = getEffectiveQuotationStatus(doc.status, doc.validUntil);
      assertQuotationTransition(effective, 'SENT');
      this.assertReadyToSend(doc);
      await this.assertCustomerActive(doc.customerId, session);
      await this.assertIssuedItemsStillAvailable(doc.items, actor.role);

      const now = new Date();
      const allocated = doc.quotationNumber
        ? undefined
        : await this.runningNumber.generateQuotationNumber(now, session);
      const quotationNumber = doc.quotationNumber ?? allocated?.quotationNumber;
      if (!quotationNumber) {
        throw new InternalServerErrorException(
          'Failed to allocate quotation number.',
        );
      }

      const updated = await this.quotationModel
        .findOneAndUpdate(
          { _id: doc._id, __v: dto.version, status: 'DRAFT' },
          {
            $set: {
              status: 'SENT',
              quotationNumber,
              issuedAt: now,
              updatedBy: actor.id,
            },
            $push: {
              statusHistory: {
                status: 'SENT',
                action: 'SEND',
                actor: actor.id,
                timestamp: now,
                reason: this.auditReason('SEND', dto.reason),
              },
            },
            $inc: { __v: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .exec();
      if (!updated) {
        throw new ConflictException(
          'Quotation changed before it could be sent. Reload and try again.',
        );
      }
      return updated;
    });
    if (!result) {
      throw new InternalServerErrorException(
        'Quotation send transaction returned no result.',
      );
    }
    return this.toResponse(result);
  }

  async approve(
    id: string,
    dto: ApproveQuotationDto,
    actor: AuthenticatedUser,
  ): Promise<QuotationResponse> {
    return this.transition(id, dto, actor, 'APPROVED', 'APPROVE');
  }

  async reject(
    id: string,
    dto: RejectQuotationDto,
    actor: AuthenticatedUser,
  ): Promise<QuotationResponse> {
    return this.transition(id, dto, actor, 'REJECTED', 'REJECT', {
      rejectionReason: dto.reason.trim(),
    });
  }

  async revise(
    id: string,
    dto: VersionedQuotationCommandDto,
    actor: AuthenticatedUser,
  ): Promise<QuotationResponse> {
    const doc = await this.findDocument(id);
    this.assertVersion(doc, dto.version);
    const effective = getEffectiveQuotationStatus(doc.status, doc.validUntil);
    if (!['SENT', 'APPROVED', 'REJECTED', 'EXPIRED'].includes(effective)) {
      throw new BadRequestException(
        `Quotation in ${effective} cannot be revised.`,
      );
    }
    assertQuotationTransition(effective, 'DRAFT');
    const now = new Date();
    doc.revisionHistory.push(
      this.snapshotRevision(doc, effective, actor.id, now),
    );
    doc.revision += 1;
    doc.status = 'DRAFT';
    doc.issuedAt = undefined;
    doc.rejectionReason = undefined;
    doc.updatedBy = actor.id;
    doc.statusHistory.push({
      status: 'DRAFT',
      action: 'REVISE',
      actor: actor.id,
      timestamp: now,
      reason: this.auditReason('REVISE', dto.reason),
    });
    try {
      return this.toResponse(await doc.save());
    } catch (error) {
      this.rethrowConcurrency(error);
    }
  }

  async cancel(
    id: string,
    dto: CancelQuotationDto,
    actor: AuthenticatedUser,
  ): Promise<QuotationResponse> {
    const doc = await this.findDocument(id);
    this.assertVersion(doc, dto.version);
    const effective = getEffectiveQuotationStatus(doc.status, doc.validUntil);
    if (!['DRAFT', 'SENT', 'APPROVED'].includes(effective)) {
      throw new BadRequestException(
        `Quotation in ${effective} cannot be cancelled.`,
      );
    }
    if (
      effective !== 'DRAFT' &&
      actor.role !== 'manager' &&
      actor.role !== 'admin'
    ) {
      throw new ForbiddenException(
        'Cancelling a Sent or Approved quotation requires manager or admin.',
      );
    }
    return this.transition(id, dto, actor, 'CANCELLED', 'CANCEL', {
      cancellationReason: dto.reason.trim(),
    });
  }

  async convertToOrder(
    id: string,
    dto: ConvertQuotationDto,
    actor: AuthenticatedUser,
    idempotencyKey?: string,
  ) {
    const normalizedKey = idempotencyKey?.trim().slice(0, 128) || undefined;
    const result = await this.connection.transaction(async (session) => {
      const doc = await this.findDocument(id, session);
      if (doc.convertedOrderId) {
        const existingOrder = await this.orderModel
          .findById(doc.convertedOrderId)
          .session(session)
          .exec();
        if (!existingOrder) {
          throw new ConflictException(
            'Quotation points to a missing converted Order. Reconciliation is required.',
          );
        }
        return { quotation: doc, order: existingOrder, replayed: true };
      }

      this.assertVersion(doc, dto.version);
      const effective = getEffectiveQuotationStatus(doc.status, doc.validUntil);
      if (effective !== 'APPROVED') {
        throw new ConflictException(
          `Only an Approved quotation can be converted. Current status is ${effective}.`,
        );
      }
      assertQuotationTransition(effective, 'CONVERTED');
      await this.assertCustomerActive(doc.customerId, session);

      const conflicts = await this.findPriceConflicts(doc.items, actor.role);
      if (conflicts.length > 0) {
        if (!dto.confirmQuotedPrice) {
          throw new ConflictException({
            code: 'QUOTATION_PRICE_CONFLICT',
            message:
              'Catalog price changed after the quotation was approved. Explicit manager confirmation is required to use the quoted price.',
            conflicts,
          });
        }
        if (actor.role !== 'manager' && actor.role !== 'admin') {
          throw new ForbiddenException(
            'Resolving a quotation price conflict requires manager or admin.',
          );
        }
        if (!dto.priceConflictReason?.trim()) {
          throw new BadRequestException(
            'priceConflictReason is required when confirming quoted prices.',
          );
        }
      }

      const now = new Date();
      const money = this.calculateQuotationMoney(
        doc.items,
        this.readStoredDiscount(doc),
        doc.taxInvoiceRequested,
      );
      this.assertMoneyMatchesStored(doc, money);
      const orderNumber = await this.runningNumber.generateOrderNumber(
        now,
        session,
      );
      const orderObjectId = new Types.ObjectId();
      const order = new this.orderModel({
        _id: orderObjectId,
        orderId: orderObjectId.toString(),
        orderType: 'NORMAL',
        orderNumber,
        quotationId: doc._id,
        quotationNumber: doc.quotationNumber,
        quotationRevision: doc.revision,
        ...(doc.customerId ? { customerId: doc.customerId } : {}),
        customerName: doc.customerSnapshot?.customerName ?? '',
        phoneNumber: doc.customerSnapshot?.phoneNumber ?? '',
        email: doc.customerSnapshot?.email,
        customerEmail: doc.customerSnapshot?.email,
        address: doc.customerSnapshot?.address,
        customerAddress: doc.customerSnapshot?.address,
        taxId: doc.customerSnapshot?.taxId,
        customerTaxId: doc.customerSnapshot?.taxId,
        branchType: doc.customerSnapshot?.branchType,
        branchNo: doc.customerSnapshot?.branchNo,
        subDistrict: doc.customerSnapshot?.subDistrict,
        district: doc.customerSnapshot?.district,
        province: doc.customerSnapshot?.province,
        postalCode: doc.customerSnapshot?.postalCode,
        note: doc.notes ?? '',
        total: money.subtotal,
        subtotal: money.subtotal,
        discount: money.discount,
        depositTotal: 0,
        paidAmount: 0,
        remainingTotal: money.grandTotal,
        payment: 'cash',
        paymentMethod: 'cash',
        status: 'awaiting_payment',
        workflowStatus: 'pending',
        saleDate: now,
        entryMode: 'normal',
        isBackdated: false,
        taxInvoiceRequested: doc.taxInvoiceRequested,
        taxInvoice: 'no',
        vatAmount: money.vatAmount,
        grandTotal: money.grandTotal,
        payments: [],
        financialAdjustments: [],
        statusHistory: [
          {
            status: 'awaiting_payment',
            changedAt: now,
            changedBy: actor.id,
            note: `Created from ${doc.quotationNumber ?? doc._id.toString()} Rev.${doc.revision}`,
          },
        ],
        cart: doc.items.map((item) => this.toOrderCartItem(item, conflicts)),
      });
      await order.save({ session });

      const conversionFingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            quotationId: doc._id.toString(),
            quotationNumber: doc.quotationNumber,
            revision: doc.revision,
            orderId: order._id.toString(),
            conflictsConfirmed: conflicts.length > 0,
          }),
        )
        .digest('hex');

      const updatedQuotation = await this.quotationModel
        .findOneAndUpdate(
          {
            _id: doc._id,
            __v: dto.version,
            status: 'APPROVED',
            convertedOrderId: { $exists: false },
          },
          {
            $set: {
              status: 'CONVERTED',
              convertedOrderId: order._id,
              convertedAt: now,
              convertedBy: actor.id,
              conversionFingerprint,
              ...(normalizedKey
                ? { conversionIdempotencyKey: normalizedKey }
                : {}),
              updatedBy: actor.id,
            },
            $push: {
              statusHistory: {
                status: 'CONVERTED',
                action: 'CONVERT_TO_ORDER',
                actor: actor.id,
                timestamp: now,
                reason: this.auditReason(
                  'CONVERT_TO_ORDER',
                  dto.priceConflictReason?.trim() || dto.reason,
                ),
              },
            },
            $inc: { __v: 1 },
          },
          { new: true, runValidators: true, session },
        )
        .exec();
      if (!updatedQuotation) {
        throw new ConflictException(
          'Quotation changed during conversion. Reload and retry.',
        );
      }
      return { quotation: updatedQuotation, order, replayed: false };
    });

    if (!result) {
      throw new InternalServerErrorException(
        'Quotation conversion transaction returned no result.',
      );
    }
    return {
      quotation: this.toResponse(result.quotation),
      order: this.toOrderReference(result.order),
      replayed: result.replayed,
    };
  }

  private auditReason(action: string, reason?: string): string {
    const explicitReason = reason?.trim();
    if (explicitReason) return explicitReason;

    const defaults: Record<string, string> = {
      CREATE: 'Quotation draft created.',
      SEND: 'Quotation sent to customer.',
      APPROVE: 'Customer approval recorded by staff.',
      REJECT: 'Customer rejection recorded by staff.',
      REVISE: 'Quotation revision created.',
      CANCEL: 'Quotation cancelled.',
      CONVERT_TO_ORDER: 'Approved quotation converted to Order.',
    };
    return defaults[action] ?? action;
  }

  private async transition(
    id: string,
    dto: VersionedQuotationCommandDto,
    actor: AuthenticatedUser,
    target: QuotationStatus,
    action: string,
    extraSet: Record<string, unknown> = {},
  ): Promise<QuotationResponse> {
    const doc = await this.findDocument(id);
    this.assertVersion(doc, dto.version);
    const effective = getEffectiveQuotationStatus(doc.status, doc.validUntil);
    assertQuotationTransition(effective, target);
    const now = new Date();
    const updated = await this.quotationModel
      .findOneAndUpdate(
        { _id: doc._id, __v: dto.version, status: doc.status },
        {
          $set: {
            status: target,
            updatedBy: actor.id,
            ...extraSet,
          },
          $push: {
            statusHistory: {
              status: target,
              action,
              actor: actor.id,
              timestamp: now,
              reason: this.auditReason(action, dto.reason),
            },
          },
          $inc: { __v: 1 },
        },
        { new: true, runValidators: true },
      )
      .exec();
    if (!updated) {
      throw new ConflictException(
        'Quotation changed before the action completed. Reload and try again.',
      );
    }
    return this.toResponse(updated);
  }

  private async findDocument(
    id: string,
    session?: ClientSession,
  ): Promise<QuotationDocument> {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('quotation id must be a valid MongoDB id.');
    }
    const query = this.quotationModel.findById(id);
    if (session) query.session(session);
    const doc = await query.exec();
    if (!doc) throw new NotFoundException('Quotation not found.');
    return doc;
  }

  private assertVersion(doc: QuotationDocument, version: number): void {
    if (doc.__v !== version) {
      throw new ConflictException(
        'Quotation has changed since this page was loaded. Reload the latest version.',
      );
    }
  }

  private rethrowConcurrency(error: unknown): never {
    if (error instanceof Error && error.name === 'VersionError') {
      throw new ConflictException(
        'Quotation was changed by another request. Reload and try again.',
      );
    }
    throw error;
  }

  private async resolveCustomerSnapshot(
    customerId?: string,
    input?: QuotationCustomerSnapshotDto,
    existing: QuotationCustomerSnapshotDto = {},
  ): Promise<{
    customerId?: Types.ObjectId;
    snapshot: QuotationCustomerSnapshotDto;
  }> {
    let base: QuotationCustomerSnapshotDto = { ...existing };
    let resolvedId: Types.ObjectId | undefined;
    if (customerId) {
      const customer = await this.customerModel
        .findOne({ _id: customerId, active: true })
        .lean()
        .exec();
      if (!customer) {
        throw new BadRequestException(
          'Selected customer does not exist or is inactive.',
        );
      }
      resolvedId = new Types.ObjectId(customerId);
      base = {
        customerName: customer.displayName,
        phoneNumber: customer.phoneNumber,
        email: customer.email,
        taxId: customer.taxId,
        branchType: customer.branchType,
        branchNo: customer.branchNo,
        address: customer.address,
        subDistrict: customer.subDistrict,
        district: customer.district,
        province: customer.province,
        postalCode: customer.postalCode,
      };
    }
    const snapshot = this.cleanSnapshot({ ...base, ...(input ?? {}) });
    return { ...(resolvedId ? { customerId: resolvedId } : {}), snapshot };
  }

  private cleanSnapshot(
    snapshot: QuotationCustomerSnapshotDto,
  ): QuotationCustomerSnapshotDto {
    const fields: Array<keyof QuotationCustomerSnapshotDto> = [
      'customerName',
      'phoneNumber',
      'email',
      'taxId',
      'branchType',
      'branchNo',
      'address',
      'subDistrict',
      'district',
      'province',
      'postalCode',
    ];
    const cleaned: QuotationCustomerSnapshotDto = {};
    for (const field of fields) {
      const value = snapshot[field];
      const trimmed = value?.trim();
      if (trimmed) cleaned[field] = trimmed;
    }
    return cleaned;
  }

  private async resolveRequestedItems(
    requests: QuotationItemRequestDto[],
    actor: AuthenticatedUser,
  ): Promise<QuotationItem[]> {
    const resolved: QuotationItem[] = [];
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index];
      const hasCatalogIdentity = Boolean(
        request.quickProductId?.trim() ||
          request.productId?.trim() ||
          request.productCode?.trim() ||
          request.typeCode?.trim(),
      );
      if (
        !hasCatalogIdentity &&
        request.customName?.trim() &&
        !request.priceOverride
      ) {
        resolved.push({
          name: request.customName.trim(),
          description: request.description?.trim(),
          quantity: request.quantity,
          unit: request.unit?.trim() || 'ชิ้น',
          authoritativeUnitPrice: 0,
          lineTotal: 0,
          productNote: request.productNote,
          note: request.note,
        });
        continue;
      }
      const orderItem = this.toOrderItemRequest(request);
      const [line] = await this.orderPricing.resolveCart(
        request.quickProductId ? 'QUICK_SALE' : 'NORMAL',
        [orderItem],
        actor.role,
      );
      resolved.push(this.toQuotationItem(request, line, actor));
    }
    return resolved;
  }

  private toOrderItemRequest(item: QuotationItemRequestDto): OrderItemDto {
    return {
      productId: item.productId,
      variantId: item.variantId,
      quickProductId: item.quickProductId,
      productCode: item.productCode,
      typeCode: item.typeCode,
      variantName: item.variantName,
      customName: item.customName,
      quantity: item.quantity,
      priceOverride: item.priceOverride,
      material: item.material,
      colorMode: item.colorMode,
      type: item.type,
      typePremium: item.typePremium,
      shape: item.shape,
      size: item.size,
      sides: item.sides,
      productNote: item.productNote,
      note: item.note,
      setCount: item.setCount,
      inkjetType: item.inkjetType,
      sizeFlex: item.sizeFlex,
      stickerPVCType: item.stickerPVCType,
      plotPlanType: item.plotPlanType,
    };
  }

  private toQuotationItem(
    request: QuotationItemRequestDto,
    line: ResolvedOrderLine,
    actor: AuthenticatedUser,
  ): QuotationItem {
    return {
      productId: line.productId,
      variantId: line.variant?.id ?? line.variant?._id ?? request.variantId,
      quickProductId: line.quickProductId ?? request.quickProductId,
      productCode: line.productCode,
      typeCode: line.typeCode,
      name: line.name,
      description: request.description?.trim(),
      quantity: line.qty,
      unit: request.unit?.trim() || 'ชิ้น',
      authoritativeUnitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      ...(request.priceOverride
        ? {
            priceOverride: {
              unitPrice: line.unitPrice,
              reason: request.priceOverride.reason.trim(),
              approvedBy: actor.id,
              approvedAt: new Date(),
            },
          }
        : {}),
      variantName: line.variantName,
      material: line.material,
      colorMode: line.colorMode,
      type: line.type,
      typePremium: line.typePremium,
      shape: line.shape,
      size: line.size,
      sides: line.sides,
      productNote: line.productNote,
      note: line.note,
      setCount: line.setCount,
      inkjetType: line.inkjetType,
      sizeFlex: line.sizeFlex,
      stickerPVCType: line.stickerPVCType,
      plotPlanType: line.plotPlanType,
    };
  }

  private calculateQuotationMoney(
    items: Array<Pick<QuotationItem, 'quantity' | 'authoritativeUnitPrice'>>,
    discount: OrderDiscountDto | undefined,
    taxInvoiceRequested: boolean,
  ): QuotationMoney {
    if (items.length === 0 && discount?.value) {
      throw new BadRequestException(
        'Discount cannot be applied before quotation items exist.',
      );
    }
    const pricedItems = items.filter((item) => item.authoritativeUnitPrice > 0);
    if (pricedItems.length === 0) {
      return {
        subtotal: 0,
        discount: 0,
        ...(discount
          ? { discountType: discount.type, discountValue: discount.value }
          : {}),
        taxableAmount: 0,
        vatRate: VAT_RATE,
        vatAmount: 0,
        grandTotal: 0,
        taxInvoiceRequested,
        currency: 'THB',
      };
    }
    const calculated = calculateOrderMoney(
      pricedItems.map((item) => ({
        quantity: item.quantity,
        unitPrice: item.authoritativeUnitPrice,
      })),
      discount,
      undefined,
      taxInvoiceRequested ? 'yes' : 'no',
    );
    const taxableMinor =
      toMinorUnits(calculated.subtotal, 'quotation subtotal') -
      toMinorUnits(calculated.discount, 'quotation discount');
    return {
      subtotal: calculated.subtotal,
      discount: calculated.discount,
      ...(discount
        ? { discountType: discount.type, discountValue: discount.value }
        : {}),
      taxableAmount: fromMinorUnits(taxableMinor),
      vatRate: VAT_RATE,
      vatAmount: calculated.vatAmount,
      grandTotal: calculated.grandTotal,
      taxInvoiceRequested,
      currency: 'THB',
    };
  }

  private readStoredDiscount(
    quotation: Pick<Quotation, 'discountType' | 'discountValue' | 'discount'>,
  ): OrderDiscountDto | undefined {
    if (quotation.discountType && quotation.discountValue !== undefined) {
      return {
        type: quotation.discountType,
        value: quotation.discountValue,
      };
    }
    return quotation.discount > 0
      ? { type: 'amount', value: quotation.discount }
      : undefined;
  }

  private assignOptionalDocumentFields(
    doc: QuotationDocument,
    dto: CreateQuotationDto,
  ): void {
    const fields = [
      'subject',
      'notes',
      'termsAndConditions',
      'paymentTerms',
      'deliveryTerms',
      'internalNote',
    ] as const;
    for (const field of fields) {
      if (dto[field] !== undefined) {
        doc[field] = dto[field]?.trim();
      }
    }
  }

  private assertReadyToSend(doc: QuotationDocument): void {
    if (!doc.customerSnapshot?.customerName?.trim()) {
      throw new BadRequestException(
        'Customer name is required before sending a quotation.',
      );
    }
    if (!doc.items.length) {
      throw new BadRequestException(
        'At least one quotation item is required before sending.',
      );
    }
    const unresolvedCustomItem = doc.items.find(
      (item) =>
        !item.productId &&
        !item.quickProductId &&
        !item.productCode &&
        !item.typeCode &&
        !item.priceOverride,
    );
    if (unresolvedCustomItem) {
      throw new BadRequestException(
        `Custom quotation item "${unresolvedCustomItem.name}" requires an explicit approved price and reason before sending.`,
      );
    }
    if (!doc.validUntil) {
      throw new BadRequestException(
        'validUntil is required before sending a quotation.',
      );
    }
    if (doc.validUntil.getTime() < Date.now()) {
      throw new BadRequestException(
        'validUntil must be in the future when the quotation is sent.',
      );
    }
  }

  private async assertCustomerActive(
    customerId: Types.ObjectId | undefined,
    session?: ClientSession,
  ): Promise<void> {
    if (!customerId) return;
    const query = this.customerModel.findOne({ _id: customerId, active: true });
    if (session) query.session(session);
    const customer = await query.select('_id').lean().exec();
    if (!customer) {
      throw new ConflictException(
        'Selected customer is inactive or unavailable. Revise the quotation before continuing.',
      );
    }
  }

  private async assertIssuedItemsStillAvailable(
    items: QuotationItem[],
    actorRole: UserRole,
  ): Promise<void> {
    for (const item of items) {
      if (
        !item.productId &&
        !item.quickProductId &&
        !item.productCode &&
        !item.typeCode
      ) {
        if (!item.priceOverride) {
          throw new ConflictException(
            `Custom quotation item "${item.name}" no longer has approved price metadata.`,
          );
        }
        continue;
      }
      const request = this.quotationItemToOrderRequest(item, false);
      await this.orderPricing.resolveCart(
        item.quickProductId ? 'QUICK_SALE' : 'NORMAL',
        [request],
        actorRole,
      );
    }
  }

  private async findPriceConflicts(
    items: QuotationItem[],
    actorRole: UserRole,
  ): Promise<ConversionConflict[]> {
    const conflicts: ConversionConflict[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const hasCatalogIdentity = Boolean(
        item.productId ||
          item.quickProductId ||
          item.productCode ||
          item.typeCode,
      );
      if (!hasCatalogIdentity) {
        if (!item.priceOverride) {
          throw new ConflictException(
            `Custom quotation item "${item.name}" has no approved price override.`,
          );
        }
        continue;
      }
      const [current] = await this.orderPricing.resolveCart(
        item.quickProductId ? 'QUICK_SALE' : 'NORMAL',
        [this.quotationItemToOrderRequest(item, false)],
        actorRole,
      );
      if (
        toMinorUnits(current.unitPrice, 'current unit price') !==
        toMinorUnits(item.authoritativeUnitPrice, 'quoted unit price')
      ) {
        conflicts.push({
          index,
          name: item.name,
          quotedUnitPrice: item.authoritativeUnitPrice,
          currentUnitPrice: current.unitPrice,
        });
      }
    }
    return conflicts;
  }

  private quotationItemToOrderRequest(
    item: QuotationItem,
    includeOverride: boolean,
  ): OrderItemDto {
    return {
      productId: item.productId,
      variantId: item.variantId,
      quickProductId: item.quickProductId,
      productCode: item.productCode,
      typeCode: item.typeCode,
      variantName: item.variantName,
      customName:
        !item.productId &&
        !item.quickProductId &&
        !item.productCode &&
        !item.typeCode
          ? item.name
          : undefined,
      quantity: item.quantity,
      ...(includeOverride && item.priceOverride
        ? {
            priceOverride: {
              unitPrice: item.authoritativeUnitPrice,
              reason: item.priceOverride.reason,
            },
          }
        : {}),
      material: item.material,
      colorMode: item.colorMode,
      type: item.type,
      typePremium: item.typePremium,
      shape: item.shape,
      size: item.size,
      sides: item.sides,
      productNote: item.productNote,
      note: item.note,
      setCount: item.setCount,
      inkjetType: item.inkjetType,
      sizeFlex: item.sizeFlex,
      stickerPVCType: item.stickerPVCType,
      plotPlanType: item.plotPlanType,
    };
  }

  private toOrderCartItem(
    item: QuotationItem,
    conflicts: ConversionConflict[],
  ) {
    const conflict = conflicts.some(
      (candidate) => candidate.name === item.name,
    );
    return {
      quickProductId: item.quickProductId,
      productId: item.productId,
      productCode: item.productCode,
      typeCode: item.typeCode,
      name: item.name,
      variantName: item.variantName,
      ...(item.variantName || item.variantId
        ? {
            variant: {
              id: item.variantId,
              _id: item.variantId,
              name: item.variantName ?? 'Default',
              price: item.authoritativeUnitPrice,
              custom: Boolean(item.priceOverride || conflict),
            },
          }
        : {}),
      qty: item.quantity,
      unitPrice: item.authoritativeUnitPrice,
      totalPrice: item.lineTotal,
      lineTotal: item.lineTotal,
      material: item.material,
      colorMode: item.colorMode,
      type: item.type,
      typePremium: item.typePremium,
      shape: item.shape,
      size: item.size,
      sides: item.sides,
      productNote: item.productNote ?? item.description,
      note: item.note,
      setCount: item.setCount,
      inkjetType: item.inkjetType,
      sizeFlex: item.sizeFlex,
      stickerPVCType: item.stickerPVCType,
      plotPlanType: item.plotPlanType,
    };
  }

  private snapshotQuotationItem(item: QuotationItem): QuotationItem {
    const itemWithToObject = item as QuotationItem & {
      toObject?: () => QuotationItem;
    };
    return typeof itemWithToObject.toObject === 'function'
      ? itemWithToObject.toObject()
      : { ...item };
  }

  private snapshotRevision(
    doc: QuotationDocument,
    effectiveStatus: QuotationStatus,
    actorId: string,
    now: Date,
  ): QuotationRevisionSnapshot {
    return {
      revision: doc.revision,
      status: effectiveStatus,
      quotationNumber: doc.quotationNumber,
      issuedAt: doc.issuedAt,
      validUntil: doc.validUntil,
      customerSnapshot: { ...(doc.customerSnapshot ?? {}) },
      items: doc.items.map((item) => this.snapshotQuotationItem(item)),
      subtotal: doc.subtotal,
      discount: doc.discount,
      discountType: doc.discountType,
      discountValue: doc.discountValue,
      taxableAmount: doc.taxableAmount,
      vatRate: doc.vatRate,
      vatAmount: doc.vatAmount,
      grandTotal: doc.grandTotal,
      taxInvoiceRequested: doc.taxInvoiceRequested,
      currency: 'THB',
      subject: doc.subject,
      notes: doc.notes,
      termsAndConditions: doc.termsAndConditions,
      paymentTerms: doc.paymentTerms,
      deliveryTerms: doc.deliveryTerms,
      internalNote: doc.internalNote,
      snapshotBy: actorId,
      snapshotAt: now,
    };
  }

  private assertMoneyMatchesStored(
    doc: QuotationDocument,
    calculated: QuotationMoney,
  ): void {
    const fields: Array<
      keyof Pick<
        Quotation,
        'subtotal' | 'discount' | 'taxableAmount' | 'vatAmount' | 'grandTotal'
      >
    > = ['subtotal', 'discount', 'taxableAmount', 'vatAmount', 'grandTotal'];
    for (const field of fields) {
      if (
        toMinorUnits(Number(doc[field]), field) !==
        toMinorUnits(Number(calculated[field]), field)
      ) {
        throw new ConflictException(
          'Quotation monetary snapshot is inconsistent. Revise and save the quotation before conversion.',
        );
      }
    }
  }

  private buildListFilter(query: ListQuotationsQueryDto, now: Date) {
    const filter: Record<string, unknown> = {};
    if (query.customerId)
      filter.customerId = new Types.ObjectId(query.customerId);
    if (query.status) {
      if (query.status === 'EXPIRED') {
        filter.status = 'SENT';
        filter.validUntil = { $lt: now };
      } else if (query.status === 'SENT') {
        filter.status = 'SENT';
        filter.validUntil = { $gte: now };
      } else {
        filter.status = query.status;
      }
    }
    if (query.search?.trim()) {
      const safe = query.search
        .trim()
        .replace(REGEX_SPECIAL_CHARS, String.raw`\$&`);
      filter.$or = [
        { quotationNumber: { $regex: safe, $options: 'i' } },
        { 'customerSnapshot.customerName': { $regex: safe, $options: 'i' } },
        { 'customerSnapshot.phoneNumber': { $regex: safe, $options: 'i' } },
        { 'customerSnapshot.taxId': { $regex: safe, $options: 'i' } },
        { subject: { $regex: safe, $options: 'i' } },
      ];
    }
    this.applyDateRange(filter, 'issuedAt', query.issuedFrom, query.issuedTo);
    this.applyDateRange(filter, 'validUntil', query.validFrom, query.validTo);
    return filter;
  }

  private applyDateRange(
    filter: Record<string, unknown>,
    field: string,
    from?: string,
    to?: string,
  ): void {
    if (!from && !to) return;
    filter[field] = {
      ...(from ? { $gte: normalizeQuotationRangeBoundary(from, 'start') } : {}),
      ...(to ? { $lte: normalizeQuotationRangeBoundary(to, 'end') } : {}),
    };
  }

  private buildSort(sort?: string): Record<string, 1 | -1> {
    switch (sort) {
      case 'oldest':
        return { createdAt: 1, _id: 1 };
      case 'validUntilAsc':
        return { validUntil: 1, _id: 1 };
      case 'validUntilDesc':
        return { validUntil: -1, _id: -1 };
      case 'amountAsc':
        return { grandTotal: 1, _id: 1 };
      case 'amountDesc':
        return { grandTotal: -1, _id: -1 };
      default:
        return { updatedAt: -1, _id: -1 };
    }
  }

  private async getSummary(now: Date) {
    const expiringUntil = new Date(now.getTime() + EXPIRING_WINDOW_MS);
    const [draft, sent, approved, expired, expiring] = await Promise.all([
      this.quotationModel.countDocuments({ status: 'DRAFT' }),
      this.quotationModel.countDocuments({
        status: 'SENT',
        validUntil: { $gte: now },
      }),
      this.quotationModel.countDocuments({ status: 'APPROVED' }),
      this.quotationModel.countDocuments({
        status: 'SENT',
        validUntil: { $lt: now },
      }),
      this.quotationModel.countDocuments({
        status: 'SENT',
        validUntil: { $gte: now, $lte: expiringUntil },
      }),
    ]);
    return {
      draft,
      sent,
      approved,
      expired,
      expiring,
      expiringOrExpired: expiring + expired,
    };
  }

  private toResponse(
    doc: QuotationDocument,
    now: Date = new Date(),
  ): QuotationResponse {
    const plain = doc.toObject() as QuotationPlain;
    const storedStatus = plain.status;
    return {
      ...plain,
      _id: doc._id.toString(),
      storedStatus,
      status: getEffectiveQuotationStatus(storedStatus, plain.validUntil, now),
      version: doc.__v ?? 0,
    };
  }

  private toOrderReference(order: OrderDocument) {
    return {
      _id: order._id.toString(),
      orderId: order.orderId ?? order._id.toString(),
      orderNumber: order.orderNumber,
      status: order.status,
      workflowStatus: order.workflowStatus,
      grandTotal: order.grandTotal,
      remainingTotal: order.remainingTotal,
      quotationId: order.quotationId?.toString(),
      quotationNumber: order.quotationNumber,
      quotationRevision: order.quotationRevision,
    };
  }
}
