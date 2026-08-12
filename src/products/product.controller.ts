// src/products/product.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Request,
} from '@nestjs/common';
import {
  CreateProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
} from './dto/product.dto';
import { ProductService } from './product.service';
import { Roles } from '../auth/auth.decorators';
import { AuditService } from '../auth/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';

type AuthRequest = { user?: AuthenticatedUser };

@Controller('products')
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  findAll(@Query() query: ListProductsQueryDto) {
    return this.productService.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.productService.findOne(id);
  }

  @Post()
  @Roles('manager', 'admin')
  async create(
    @Body() body: CreateProductDto,
    @Request() request: AuthRequest,
  ) {
    const product = await this.productService.create(body);
    await this.auditService.record(request.user ?? null, 'product.create', {
      type: 'product',
      id: product.code,
    });
    return product;
  }

  @Patch(':id')
  @Roles('manager', 'admin')
  async update(
    @Param('id') id: string,
    @Body() body: UpdateProductDto,
    @Request() request: AuthRequest,
  ) {
    const product = await this.productService.update(id, body);
    await this.auditService.record(request.user ?? null, 'product.update', {
      type: 'product',
      id: product.code,
    });
    return product;
  }

  @Delete(':id')
  @Roles('admin')
  async delete(@Param('id') id: string, @Request() request: AuthRequest) {
    const product = await this.productService.delete(id);
    await this.auditService.record(request.user ?? null, 'product.delete', {
      type: 'product',
      id: product.code,
    });
    return product;
  }
}
