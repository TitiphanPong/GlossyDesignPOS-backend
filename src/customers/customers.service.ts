import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { isValidObjectId, Model, Types } from 'mongoose';
import { Order, OrderDocument } from '../orders/orders.schema';
import {
  ProductionJob,
  ProductionJobDocument,
} from '../production/schemas/production-job.schema';
import { Upload, UploadDocument } from '../uploads/schemas/upload.schema';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';
import { Customer, CustomerDocument } from './schemas/customer.schema';

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

@Injectable()
export class CustomersService {
  constructor(
    @InjectModel(Customer.name)
    private readonly customerModel: Model<CustomerDocument>,
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    @InjectModel(ProductionJob.name)
    private readonly productionModel: Model<ProductionJobDocument>,
    @InjectModel(Upload.name)
    private readonly uploadModel: Model<UploadDocument>,
  ) {}

  async list(query: ListCustomersQueryDto = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const filter: Record<string, unknown> = {};
    if (query.active !== undefined) filter.active = query.active;
    if (query.search?.trim()) {
      const safe = query.search
        .trim()
        .replace(REGEX_SPECIAL_CHARS, String.raw`\$&`);
      filter.$or = [
        { customerCode: { $regex: safe, $options: 'i' } },
        { displayName: { $regex: safe, $options: 'i' } },
        { companyName: { $regex: safe, $options: 'i' } },
        { phoneNumber: { $regex: safe, $options: 'i' } },
        { phoneNumbers: { $regex: safe, $options: 'i' } },
        { email: { $regex: safe, $options: 'i' } },
        { taxId: { $regex: safe, $options: 'i' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.customerModel
        .find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.customerModel.countDocuments(filter),
    ]);
    return { data, page, limit, total };
  }

  async create(dto: CreateCustomerDto) {
    if (!dto.displayName?.trim()) {
      throw new BadRequestException('Customer name is required.');
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const phoneFields = this.normalizePhoneFields(dto);
        return await this.customerModel.create({
          ...dto,
          ...phoneFields,
          customerCode: `CUS-${randomBytes(5).toString('hex').toUpperCase()}`,
          active: true,
        });
      } catch (error) {
        if (!this.isDuplicateKey(error)) throw error;
      }
    }
    throw new BadRequestException('Failed to allocate customer identity.');
  }

  async update(id: string, dto: UpdateCustomerDto) {
    this.assertId(id);
    const shouldUpdatePhones =
      dto.phoneNumber !== undefined || dto.phoneNumbers !== undefined;
    const rest: Record<string, unknown> = { ...dto };
    delete rest.phoneNumber;
    delete rest.phoneNumbers;

    const unsetFields: Record<string, 1> = {};
    const clearableFields = [
      'email',
      'taxId',
      'companyName',
      'address',
      'branchType',
      'branchNo',
      'subDistrict',
      'district',
      'province',
      'postalCode',
      'shippingAddress',
    ] as const;
    for (const field of clearableFields) {
      if (rest[field] === null) {
        delete rest[field];
        unsetFields[field] = 1;
      }
    }

    const phoneFields = shouldUpdatePhones
      ? this.normalizePhoneFields(dto)
      : undefined;
    const update: Record<string, unknown> = {
      $set: {
        ...rest,
        ...(phoneFields ?? {}),
      },
    };
    if (phoneFields && !phoneFields.phoneNumber) {
      unsetFields.phoneNumber = 1;
    }
    if (Object.keys(unsetFields).length > 0) {
      update.$unset = unsetFields;
    }
    const updated = await this.customerModel
      .findByIdAndUpdate(id, update, { new: true, runValidators: true })
      .exec();
    if (!updated) throw new NotFoundException('Customer not found.');
    return updated;
  }

  async detail(id: string) {
    this.assertId(id);
    const customer = await this.customerModel.findById(id).lean().exec();
    if (!customer) throw new NotFoundException('Customer not found.');
    const customerObjectId = new Types.ObjectId(id);
    const [orders, summaryRows] = await Promise.all([
      this.orderModel
        .find({ customerId: customerObjectId })
        .select(
          '_id orderNumber orderId saleDate createdAt grandTotal paidAmount remainingTotal status workflowStatus taxInvoice',
        )
        .sort({ createdAt: -1 })
        .limit(100)
        .lean()
        .exec(),
      this.orderModel
        .aggregate<{ orderCount: number; outstandingTotal: number }>([
          { $match: { customerId: customerObjectId } },
          {
            $group: {
              _id: null,
              orderCount: { $sum: 1 },
              outstandingTotal: {
                $sum: {
                  $cond: [
                    { $ne: ['$status', 'cancelled'] },
                    { $ifNull: ['$remainingTotal', 0] },
                    0,
                  ],
                },
              },
            },
          },
          { $project: { _id: 0, orderCount: 1, outstandingTotal: 1 } },
        ])
        .exec(),
    ]);
    const [jobs, uploads] = await Promise.all([
      this.orderModel
        .aggregate([
          { $match: { customerId: customerObjectId } },
          {
            $lookup: {
              from: this.productionModel.collection.name,
              localField: '_id',
              foreignField: 'orderId',
              pipeline: [
                { $match: { stage: { $nin: ['delivered'] } } },
                {
                  $project: {
                    jobNumber: 1,
                    orderId: 1,
                    orderNumber: 1,
                    workSummary: 1,
                    dueAt: 1,
                    priority: 1,
                    stage: 1,
                  },
                },
              ],
              as: 'relatedProductionJobs',
            },
          },
          { $unwind: '$relatedProductionJobs' },
          { $replaceRoot: { newRoot: '$relatedProductionJobs' } },
          { $sort: { dueAt: 1 } },
        ])
        .exec(),
      this.orderModel
        .aggregate([
          { $match: { customerId: customerObjectId } },
          { $set: { _linkedOrderId: { $toString: '$_id' } } },
          {
            $lookup: {
              from: this.uploadModel.collection.name,
              localField: '_linkedOrderId',
              foreignField: 'linkedOrderId',
              pipeline: [
                {
                  $project: {
                    uploadId: 1,
                    orderCode: 1,
                    linkedOrderId: 1,
                    linkedOrderNumber: 1,
                    jobType: 1,
                    status: 1,
                    createdAt: 1,
                  },
                },
              ],
              as: 'relatedUploads',
            },
          },
          { $unwind: '$relatedUploads' },
          { $replaceRoot: { newRoot: '$relatedUploads' } },
          { $sort: { createdAt: -1 } },
        ])
        .exec(),
    ]);
    const summary = summaryRows[0] ?? { orderCount: 0, outstandingTotal: 0 };
    return {
      customer,
      summary: {
        orderCount: Number(summary.orderCount || 0),
        outstandingTotal: Number(summary.outstandingTotal || 0),
      },
      orders,
      activeProductionJobs: jobs,
      linkedUploads: uploads,
    };
  }

  private assertId(id: string) {
    if (!isValidObjectId(id)) {
      throw new BadRequestException('Invalid customer id.');
    }
  }

  private normalizePhoneFields(dto: {
    phoneNumber?: string;
    phoneNumbers?: string[];
  }): { phoneNumber?: string; phoneNumbers: string[] } {
    const phoneNumbers = [dto.phoneNumber, ...(dto.phoneNumbers ?? [])]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter(
        (value, index, values) => value && values.indexOf(value) === index,
      );
    return {
      phoneNumbers,
      ...(phoneNumbers[0] ? { phoneNumber: phoneNumbers[0] } : {}),
    };
  }

  private isDuplicateKey(error: unknown): boolean {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: number }).code === 11000,
    );
  }
}
