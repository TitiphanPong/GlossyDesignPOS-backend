import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { QuickProduct, QuickProductDocument } from './quick-product.schema';
import {
  CreateQuickProductDto,
  ReorderQuickProductItemDto,
  UpdateQuickProductDto,
} from './quick-product.dto';

@Injectable()
export class QuickProductService {
  constructor(
    @InjectModel(QuickProduct.name)
    private readonly quickProductModel: Model<QuickProductDocument>,
  ) {}

  async findAll(includeInactive = false): Promise<QuickProduct[]> {
    return this.quickProductModel
      .find(
        includeInactive
          ? {}
          : { active: { $ne: false }, quickSaleEnabled: { $ne: false } },
      )
      .sort({ quickSaleSortOrder: 1, name: 1 })
      .exec();
  }

  async create(dto: CreateQuickProductDto): Promise<QuickProduct> {
    const code = this.slugify(dto.code);
    try {
      return await this.quickProductModel.create({
        ...dto,
        code,
        typeCode: this.slugify(dto.typeCode || code),
        active: dto.active ?? true,
        quickSaleEnabled: true,
        isHotMenu: dto.isHotMenu ?? false,
        quickSaleSortOrder: dto.quickSaleSortOrder ?? 0,
        priceDisplayMode: 'FIXED',
        variants: [{ name: 'Default', price: dto.price, active: true }],
      });
    } catch (error) {
      if (this.isDuplicate(error))
        throw new ConflictException('Quick menu code already exists');
      throw error;
    }
  }

  async update(id: string, dto: UpdateQuickProductDto): Promise<QuickProduct> {
    const { price, ...fields } = dto;
    const update: Record<string, unknown> = { ...fields };
    if (dto.code) update.code = this.slugify(dto.code);
    if (dto.typeCode) update.typeCode = this.slugify(dto.typeCode);
    if (price !== undefined)
      update.variants = [{ name: 'Default', price, active: true }];
    try {
      const product = await this.quickProductModel
        .findByIdAndUpdate(
          id,
          { $set: update },
          { new: true, runValidators: true },
        )
        .exec();
      if (!product) throw new NotFoundException('Quick menu not found');
      return product;
    } catch (error) {
      if (this.isDuplicate(error))
        throw new ConflictException('Quick menu code already exists');
      throw error;
    }
  }

  async remove(id: string): Promise<QuickProduct> {
    const product = await this.quickProductModel.findByIdAndDelete(id).exec();
    if (!product) throw new NotFoundException('Quick menu not found');
    return product;
  }

  async reorder(items: ReorderQuickProductItemDto[]): Promise<QuickProduct[]> {
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
