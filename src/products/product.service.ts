// src/products/product.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, isValidObjectId, Model } from 'mongoose';
import {
  CreateProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
} from './dto/product.dto';
import { Product, ProductDocument } from './product.schema';

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

@Injectable()
export class ProductService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  async findAll(query: ListProductsQueryDto): Promise<Product[]> {
    const filter: FilterQuery<ProductDocument> = {};

    if (query.includeInactive !== 'true') {
      filter.active = { $ne: false };
      filter.deletedAt = { $exists: false };
    }
    if (query.category?.trim()) {
      filter.category = query.category.trim();
    }
    if (query.q?.trim()) {
      const safe = query.q.trim().replace(REGEX_SPECIAL_CHARS, String.raw`\$&`);
      filter.$or = [
        { name: { $regex: safe, $options: 'i' } },
        { code: { $regex: safe, $options: 'i' } },
        { typeCode: { $regex: safe, $options: 'i' } },
        { category: { $regex: safe, $options: 'i' } },
      ];
    }

    return this.productModel
      .find(filter)
      .sort({ sortOrder: 1, category: 1, name: 1 })
      .exec();
  }

  async findOne(id: string): Promise<Product> {
    const product = await this.findByIdOrCode(id);
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async create(data: CreateProductDto): Promise<Product> {
    this.validateVariants(data.variants);
    const normalized = this.normalizeCreate(data);

    try {
      return await this.productModel.create(normalized);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException('Product code or typeCode already exists');
      }
      throw error;
    }
  }

  async update(id: string, data: UpdateProductDto): Promise<Product> {
    if (data.variants) {
      this.validateVariants(data.variants);
    }

    const updated = await this.productModel
      .findOneAndUpdate(
        this.selectorForIdOrCode(id),
        { $set: this.normalizeUpdate(data) },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException('Product not found');
    }
    return updated;
  }

  async delete(id: string): Promise<Product> {
    const updated = await this.productModel
      .findOneAndUpdate(
        this.selectorForIdOrCode(id),
        { $set: { active: false, deletedAt: new Date() } },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException('Product not found');
    }
    return updated;
  }

  private async findByIdOrCode(id: string): Promise<ProductDocument | null> {
    return this.productModel.findOne(this.selectorForIdOrCode(id)).exec();
  }

  private selectorForIdOrCode(id: string): FilterQuery<ProductDocument> {
    return isValidObjectId(id)
      ? { $or: [{ _id: id }, { code: id }, { typeCode: id }] }
      : { $or: [{ code: id }, { typeCode: id }] };
  }

  private normalizeCreate(data: CreateProductDto): Partial<Product> {
    const code = this.slugify(data.code || data.name);
    const typeCode = this.slugify(data.typeCode || data.code || data.name);
    if (!code || !typeCode) {
      throw new BadRequestException('Product code and typeCode are required');
    }

    return {
      ...data,
      code,
      typeCode,
      active: data.active ?? true,
      variants: data.variants.map((variant) => ({
        ...variant,
        code: variant.code ? this.slugify(variant.code) : undefined,
        active: variant.active ?? true,
      })),
    };
  }

  private normalizeUpdate(data: UpdateProductDto): Partial<Product> {
    const { variants, ...rest } = data;
    const normalized: Partial<Product> = {
      ...rest,
      ...(data.code ? { code: this.slugify(data.code) } : {}),
      ...(data.typeCode ? { typeCode: this.slugify(data.typeCode) } : {}),
    };

    if (variants) {
      normalized.variants = variants.map((variant) => ({
        ...variant,
        code: variant.code ? this.slugify(variant.code) : undefined,
        active: variant.active ?? true,
      }));
    }

    return normalized;
  }

  private validateVariants(variants: CreateProductDto['variants']): void {
    if (!variants?.length) {
      throw new BadRequestException('At least one product variant is required');
    }
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
