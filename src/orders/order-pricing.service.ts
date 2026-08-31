import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import {
  Product,
  ProductDocument,
  ProductVariant,
} from '../products/product.schema';
import {
  QuickProduct,
  QuickProductDocument,
} from '../quick-products/quick-product.schema';
import { fromMinorUnits, toMinorUnits } from './order-money';
import { OrderItemDto } from './dto/order.dto';
import { OrderType } from './orders.schema';
import { UserRole } from '../auth/auth.constants';

type CatalogVariant = ProductVariant & {
  _id?: { toString(): string } | string;
};
type CatalogProduct = {
  _id: { toString(): string };
  name: string;
  code: string;
  typeCode: string;
  category: string;
  active: boolean;
  variants: CatalogVariant[];
};

type CatalogResolution = {
  product: CatalogProduct;
  quickProductId?: string;
  mappedVariantId?: string;
};

export type ResolvedOrderLine = {
  quickProductId?: string;
  productId?: string;
  productCode?: string;
  typeCode?: string;
  name: string;
  category?: string;
  variantName?: string;
  variant?: {
    id?: string;
    _id?: string;
    name: string;
    price: number;
    note?: string;
    material?: string;
    sides?: string;
    size?: string;
    active?: boolean;
    custom?: boolean;
  };
  qty: number;
  unitPrice: number;
  totalPrice: number;
  lineTotal: number;
  material?: string;
  colorMode?: string;
  type?: string;
  typePremium?: string;
  shape?: string;
  size?: string;
  setCount?: number;
  inkjetType?: string;
  sizeFlex?: { height: string; width: string }[];
  stickerPVCType?: string;
  plotPlanType?: string;
  sides?: string;
  productNote?: string;
  note?: string;
  fullPayment?: boolean;
};

@Injectable()
export class OrderPricingService {
  constructor(
    @InjectModel(Product.name)
    private readonly productModel: Model<ProductDocument>,
    @InjectModel(QuickProduct.name)
    private readonly quickProductModel: Model<QuickProductDocument>,
  ) {}

  async resolveCart(
    orderType: OrderType,
    items: OrderItemDto[],
    actorRole?: UserRole,
  ): Promise<ResolvedOrderLine[]> {
    if (!items.length) {
      throw new BadRequestException(
        'Order cart must contain at least one item.',
      );
    }

    return Promise.all(
      items.map((item, index) =>
        this.resolveLine(orderType, item, index, actorRole),
      ),
    );
  }

  private async resolveLine(
    orderType: OrderType,
    item: OrderItemDto,
    index: number,
    actorRole?: UserRole,
  ): Promise<ResolvedOrderLine> {
    if (
      item.priceOverride &&
      actorRole !== 'manager' &&
      actorRole !== 'admin'
    ) {
      throw new ForbiddenException(
        `cart.${index} price override requires manager or admin authorization.`,
      );
    }
    const hasCatalogIdentity = Boolean(
      item.quickProductId?.trim() ||
        item.productId?.trim() ||
        item.productCode?.trim() ||
        item.typeCode?.trim(),
    );
    const catalog = hasCatalogIdentity
      ? await this.findCatalogProduct(orderType, item)
      : null;
    const product = catalog?.product ?? null;

    if (hasCatalogIdentity && !product) {
      throw new BadRequestException(
        `cart.${index} references an unavailable product.`,
      );
    }
    if (!product && (!item.customName?.trim() || !item.priceOverride)) {
      throw new BadRequestException(
        `cart.${index} requires a catalog identity or an explicit custom price override.`,
      );
    }
    if (
      catalog?.mappedVariantId &&
      item.variantId?.trim() &&
      item.variantId.trim() !== catalog.mappedVariantId
    ) {
      throw new BadRequestException(
        `cart.${index} variant does not match the configured quick menu mapping.`,
      );
    }

    const variant = product
      ? this.resolveVariant(
          product,
          catalog?.mappedVariantId
            ? { ...item, variantId: catalog.mappedVariantId }
            : item,
          index,
        )
      : undefined;
    const unitPrice = item.priceOverride?.unitPrice ?? variant?.price;
    if (unitPrice === undefined) {
      throw new BadRequestException(
        `cart.${index} has no authoritative price.`,
      );
    }

    const unitPriceMinor = toMinorUnits(unitPrice, `cart.${index}.unitPrice`);
    if (unitPriceMinor <= 0) {
      throw new BadRequestException(
        `cart.${index}.unitPrice must be greater than 0.`,
      );
    }
    const lineTotalMinor = unitPriceMinor * item.quantity;
    if (!Number.isSafeInteger(lineTotalMinor)) {
      throw new BadRequestException(
        `cart.${index} total is outside the supported range.`,
      );
    }

    const resolvedUnitPrice = fromMinorUnits(unitPriceMinor);
    const resolvedVariantName = item.variantName ?? variant?.name;
    const productId = product?._id.toString();
    const name = product
      ? resolvedVariantName && resolvedVariantName.toLowerCase() !== 'default'
        ? `${product.name} — ${resolvedVariantName}`
        : product.name
      : item.customName!.trim();

    return {
      ...(catalog?.quickProductId
        ? { quickProductId: catalog.quickProductId }
        : {}),
      ...(productId ? { productId } : {}),
      ...(product?.code ? { productCode: product.code } : {}),
      ...(product?.typeCode ? { typeCode: product.typeCode } : {}),
      name,
      ...(product?.category ? { category: product.category } : {}),
      ...(resolvedVariantName ? { variantName: resolvedVariantName } : {}),
      ...(variant
        ? {
            variant: {
              id: this.variantId(variant),
              _id: this.variantId(variant),
              name: variant.name,
              price: resolvedUnitPrice,
              note: variant.note,
              material: variant.material,
              sides: variant.sides,
              size: variant.size,
              active: variant.active,
              custom: Boolean(item.priceOverride),
            },
          }
        : {}),
      qty: item.quantity,
      unitPrice: resolvedUnitPrice,
      totalPrice: fromMinorUnits(lineTotalMinor),
      lineTotal: fromMinorUnits(lineTotalMinor),
      material: item.material,
      colorMode: item.colorMode,
      type: item.type,
      typePremium: item.typePremium,
      shape: item.shape,
      size: item.size,
      setCount: item.setCount,
      inkjetType: item.inkjetType,
      sizeFlex: item.sizeFlex,
      stickerPVCType: item.stickerPVCType,
      plotPlanType: item.plotPlanType,
      sides: item.sides,
      productNote: item.productNote,
      note: item.note,
      fullPayment: item.fullPayment,
    };
  }

  private async findCatalogProduct(
    orderType: OrderType,
    item: OrderItemDto,
  ): Promise<CatalogResolution | null> {
    const identities: Record<string, string>[] = [];
    if (orderType === 'QUICK_SALE' && item.quickProductId?.trim()) {
      const quickProductId = item.quickProductId.trim();
      if (!isValidObjectId(quickProductId)) return null;
      identities.push({ _id: quickProductId });
    } else if (
      item.productId?.trim() &&
      isValidObjectId(item.productId.trim())
    ) {
      identities.push({ _id: item.productId.trim() });
    }
    if (!(orderType === 'QUICK_SALE' && item.quickProductId?.trim())) {
      if (item.productCode?.trim())
        identities.push({ code: item.productCode.trim() });
      if (item.typeCode?.trim())
        identities.push({ typeCode: item.typeCode.trim() });
    }
    if (!identities.length) return null;

    const filter = { active: true, $or: identities };
    if (orderType === 'QUICK_SALE') {
      const quickProduct = await this.quickProductModel.findOne(filter).exec();
      if (!quickProduct) return null;

      const quickProductId = quickProduct._id.toString();
      if (!quickProduct.productId) {
        return { product: this.toCatalogProduct(quickProduct), quickProductId };
      }

      const canonical = await this.productModel
        .findOne({ _id: quickProduct.productId, active: true })
        .exec();
      if (!canonical) return null;
      const canonicalId = canonical._id.toString();
      if (
        item.quickProductId?.trim() &&
        item.productId?.trim() &&
        item.productId.trim() !== canonicalId
      ) {
        return null;
      }
      return {
        product: this.toCatalogProduct(canonical),
        quickProductId,
        ...(quickProduct.variantId
          ? { mappedVariantId: quickProduct.variantId.toString() }
          : {}),
      };
    }
    const product = await this.productModel.findOne(filter).exec();
    return product ? { product: this.toCatalogProduct(product) } : null;
  }

  private toCatalogProduct(
    product: ProductDocument | QuickProductDocument,
  ): CatalogProduct {
    return {
      _id: product._id,
      name: product.name,
      code: product.code,
      typeCode: product.typeCode,
      category: product.category,
      active: product.active,
      variants: product.variants,
    };
  }

  private resolveVariant(
    product: CatalogProduct,
    item: OrderItemDto,
    index: number,
  ): CatalogVariant {
    const activeVariants = (product.variants ?? []).filter(
      (variant) => variant.active !== false,
    );
    let variant: CatalogVariant | undefined;
    const variantId = item.variantId?.trim();
    const variantName = item.variantName?.trim();
    if (variantId) {
      variant = activeVariants.find(
        (candidate) => this.variantId(candidate) === variantId,
      );
    } else if (variantName) {
      variant = activeVariants.find(
        (candidate) => candidate.name === variantName,
      );
    } else if (activeVariants.length === 1) {
      [variant] = activeVariants;
    }

    if (!variant) {
      throw new BadRequestException(
        `cart.${index} requires a valid active catalog variant.`,
      );
    }
    return variant;
  }

  private variantId(variant: CatalogVariant): string | undefined {
    return variant._id?.toString();
  }
}
