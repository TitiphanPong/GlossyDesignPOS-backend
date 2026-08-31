import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Product,
  ProductDocument,
  ProductVariant,
} from '../products/product.schema';
import { QuickProduct, QuickProductDocument } from './quick-product.schema';
import {
  CreateQuickProductDto,
  ReorderQuickProductItemDto,
  UpdateQuickProductDto,
} from './quick-product.dto';

type CatalogVariant = ProductVariant & {
  _id?: Types.ObjectId | { toString(): string } | string;
};

type QuickProductView = Record<string, unknown> & {
  quickProductId: string;
  productId?: string;
  variantId?: string;
};

@Injectable()
export class QuickProductService {
  constructor(
    @InjectModel(QuickProduct.name)
    private readonly quickProductModel: Model<QuickProductDocument>,
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
  ) {}

  async findAll(includeInactive = false): Promise<QuickProductView[]> {
    const products = await this.quickProductModel
      .find(
        includeInactive
          ? {}
          : { active: { $ne: false }, quickSaleEnabled: { $ne: false } },
      )
      .sort({ quickSaleSortOrder: 1, name: 1 })
      .exec();

    return Promise.all(products.map((product) => this.toView(product)));
  }

  async create(dto: CreateQuickProductDto): Promise<QuickProductView> {
    const mapped = dto.productId
      ? await this.resolveCanonicalMapping(dto.productId, dto.variantId)
      : null;
    const code = this.slugify(dto.code);
    const typeCode = this.slugify(dto.typeCode || code);
    const canonicalFields = mapped
      ? this.canonicalSnapshot(mapped.product, mapped.variant)
      : {
          name: dto.name,
          category: dto.category,
          variants: [{ name: 'Default', price: dto.price, active: true }],
        };

    try {
      const product = await this.quickProductModel.create({
        ...dto,
        ...canonicalFields,
        code,
        typeCode,
        ...(mapped
          ? {
              productId: mapped.product._id,
              variantId: mapped.variant._id,
              catalogLinkSource: 'manual',
            }
          : {}),
        active: dto.active ?? true,
        quickSaleEnabled: true,
        isHotMenu: dto.isHotMenu ?? false,
        quickSaleSortOrder: dto.quickSaleSortOrder ?? 0,
        priceDisplayMode: 'FIXED',
      });
      return this.toView(product);
    } catch (error) {
      if (this.isDuplicate(error))
        throw new ConflictException('Quick menu code already exists');
      throw error;
    }
  }

  async update(
    id: string,
    dto: UpdateQuickProductDto,
  ): Promise<QuickProductView> {
    const existing = await this.quickProductModel.findById(id).exec();
    if (!existing) throw new NotFoundException('Quick menu not found');

    const requestedProductId = dto.productId ?? existing.productId?.toString();
    const requestedVariantId = dto.variantId ?? existing.variantId?.toString();
    const mapped = requestedProductId
      ? await this.resolveCanonicalMapping(
          requestedProductId,
          requestedVariantId,
        )
      : null;

    const { price } = dto;
    const fields: Record<string, unknown> = { ...dto };
    delete fields.price;
    delete fields.productId;
    delete fields.variantId;
    const update: Record<string, unknown> = { ...fields };

    if (mapped) {
      Object.assign(
        update,
        this.canonicalSnapshot(mapped.product, mapped.variant),
        {
          ...(dto.code ? { code: this.slugify(dto.code) } : {}),
          ...(dto.typeCode ? { typeCode: this.slugify(dto.typeCode) } : {}),
          productId: mapped.product._id,
          variantId: mapped.variant._id,
          catalogLinkSource:
            dto.productId || dto.variantId
              ? 'manual'
              : existing.catalogLinkSource,
        },
      );
    } else {
      if (dto.code) update.code = this.slugify(dto.code);
      if (dto.typeCode) update.typeCode = this.slugify(dto.typeCode);
      if (price !== undefined)
        update.variants = [{ name: 'Default', price, active: true }];
    }

    try {
      const product = await this.quickProductModel
        .findByIdAndUpdate(
          id,
          { $set: update },
          { new: true, runValidators: true },
        )
        .exec();
      if (!product) throw new NotFoundException('Quick menu not found');
      return this.toView(product);
    } catch (error) {
      if (this.isDuplicate(error))
        throw new ConflictException('Quick menu code already exists');
      throw error;
    }
  }

  async remove(id: string): Promise<QuickProductView> {
    const product = await this.quickProductModel.findByIdAndDelete(id).exec();
    if (!product) throw new NotFoundException('Quick menu not found');
    return this.toView(product);
  }

  async reorder(
    items: ReorderQuickProductItemDto[],
  ): Promise<QuickProductView[]> {
    await this.quickProductModel.bulkWrite(
      items.map((item) => ({
        updateOne: {
          filter: { _id: item.id },
          update: { $set: { quickSaleSortOrder: item.quickSaleSortOrder } },
        },
      })),
      { ordered: false },
    );
    return this.findAll(true);
  }

  private async toView(
    product: QuickProductDocument,
  ): Promise<QuickProductView> {
    const plain = (typeof product.toObject === 'function'
      ? product.toObject()
      : product) as unknown as Record<string, unknown>;
    const quickProductId = product._id?.toString();
    if (!product.productId) {
      return quickProductId
        ? { ...plain, quickProductId }
        : (plain as QuickProductView);
    }
    if (!quickProductId) {
      throw new BadRequestException(
        'Mapped quick menu is missing its identity',
      );
    }

    const canonical = await this.productModel
      .findById(product.productId)
      .exec();
    if (!canonical) {
      return {
        ...plain,
        quickProductId,
        productId: product.productId.toString(),
        ...(product.variantId
          ? { variantId: product.variantId.toString() }
          : {}),
      };
    }

    const variants = canonical.variants as CatalogVariant[];
    const selectedVariant = product.variantId
      ? variants.find(
          (variant) =>
            this.variantId(variant) === product.variantId?.toString(),
        )
      : variants.find((variant) => variant.active !== false);

    return {
      ...plain,
      quickProductId,
      productId: canonical._id.toString(),
      ...(selectedVariant
        ? {
            variantId: this.variantId(selectedVariant),
            variants: [selectedVariant],
          }
        : { variants }),
      name: canonical.name,
      category: canonical.category,
      active: product.active !== false && canonical.active !== false,
    };
  }

  private async resolveCanonicalMapping(
    productId: string,
    variantId?: string,
  ): Promise<{ product: ProductDocument; variant: CatalogVariant }> {
    const product = await this.productModel.findById(productId).exec();
    if (!product || product.active === false || product.deletedAt) {
      throw new BadRequestException('Mapped catalog product is unavailable');
    }

    const variants = (product.variants as CatalogVariant[]).filter(
      (variant) => variant.active !== false,
    );
    const variant = variantId
      ? variants.find((candidate) => this.variantId(candidate) === variantId)
      : variants.length === 1
        ? variants[0]
        : undefined;
    if (!variant) {
      throw new BadRequestException(
        'Mapped catalog product requires one explicit active variant',
      );
    }
    return { product, variant };
  }

  private canonicalSnapshot(
    product: ProductDocument,
    variant: CatalogVariant,
  ): Pick<QuickProduct, 'name' | 'category' | 'variants'> {
    return {
      name: product.name,
      category: product.category,
      variants: [variant],
    };
  }

  private variantId(variant: CatalogVariant): string | undefined {
    return variant._id?.toString();
  }

  private slugify(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private isDuplicate(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
