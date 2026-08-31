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
  StockItem,
  StockItemDocument,
} from '../inventory/schemas/stock-item.schema';
import {
  CreateProductDto,
  ListProductsQueryDto,
  MaterialRecipeComponentDto,
  ProductVariantDto,
  UpdateProductDto,
} from './dto/product.dto';
import { Product, ProductDocument } from './product.schema';

const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

@Injectable()
export class ProductService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(StockItem.name)
    private readonly stockItemModel: Model<StockItemDocument>,
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
    await this.validateRecipes(data.recipe, data.variants);
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
    await this.validateRecipes(data.recipe, data.variants);

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
      recipe: this.normalizeRecipe(data.recipe),
      variants: data.variants.map((variant) => ({
        ...variant,
        code: variant.code ? this.slugify(variant.code) : undefined,
        active: variant.active ?? true,
        recipe: this.normalizeRecipe(variant.recipe),
      })),
    };
  }

  private normalizeUpdate(data: UpdateProductDto): Partial<Product> {
    const { variants, ...rest } = data;
    const normalized: Partial<Product> = {
      ...rest,
      ...(data.code ? { code: this.slugify(data.code) } : {}),
      ...(data.typeCode ? { typeCode: this.slugify(data.typeCode) } : {}),
      ...(data.recipe !== undefined
        ? { recipe: this.normalizeRecipe(data.recipe) }
        : {}),
    };

    if (variants) {
      normalized.variants = variants.map((variant) => ({
        ...variant,
        code: variant.code ? this.slugify(variant.code) : undefined,
        active: variant.active ?? true,
        recipe: this.normalizeRecipe(variant.recipe),
      }));
    }

    return normalized;
  }

  private async validateRecipes(
    productRecipe?: MaterialRecipeComponentDto[],
    variants?: ProductVariantDto[],
  ): Promise<void> {
    const recipes = [
      ...(productRecipe ? [productRecipe] : []),
      ...(variants ?? []).flatMap((variant) =>
        variant.recipe ? [variant.recipe] : [],
      ),
    ];
    const components = recipes.flat();
    if (!components.length) return;

    const ids = [
      ...new Set(components.map((component) => component.stockItemId.trim())),
    ];
    if (ids.some((id) => !isValidObjectId(id))) {
      throw new BadRequestException(
        'Recipe stockItemId must be a valid stock item id.',
      );
    }

    const items = await this.stockItemModel
      .find({ _id: { $in: ids }, active: { $ne: false } })
      .select({ _id: 1, unit: 1 })
      .lean()
      .exec();
    const itemById = new Map(items.map((item) => [String(item._id), item]));

    for (const component of components) {
      const stockItemId = component.stockItemId.trim();
      const item = itemById.get(stockItemId);
      if (!item) {
        throw new BadRequestException(
          `Recipe stock item "${stockItemId}" was not found or is inactive.`,
        );
      }
      const recipeUnit = component.unit.trim().toLowerCase();
      const stockUnit = item.unit.trim().toLowerCase();
      if (recipeUnit !== stockUnit && !component.conversionFactor) {
        throw new BadRequestException(
          `Recipe unit "${component.unit}" requires conversionFactor for stock unit "${item.unit}".`,
        );
      }
    }
  }

  private normalizeRecipe(recipe?: MaterialRecipeComponentDto[]) {
    return recipe?.map((component) => ({
      stockItemId: component.stockItemId.trim(),
      quantity: component.quantity,
      unit: component.unit.trim(),
      conversionFactor: component.conversionFactor,
    }));
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
