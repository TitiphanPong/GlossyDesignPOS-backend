import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { QuickProduct, QuickProductDocument } from './quick-product.schema';

@Injectable()
export class QuickProductService {
  constructor(
    @InjectModel(QuickProduct.name)
    private readonly quickProductModel: Model<QuickProductDocument>,
  ) {}

  async findAll(): Promise<QuickProduct[]> {
    return this.quickProductModel
      .find({ active: { $ne: false } })
      .sort({ quickSaleSortOrder: 1, name: 1 })
      .exec();
  }
}
