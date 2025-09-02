// src/products/product.service.ts
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from './product.schema';

@Injectable()
export class ProductService {
  constructor(
    @InjectModel(Product.name) private productModel: Model<ProductDocument>,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productModel.find().exec();
  }

  async create(data: Partial<Product>): Promise<Product> {
    return this.productModel.create(data);
  }

  async delete(id: string) {
    return this.productModel.findByIdAndDelete(id);
  }
}
