import { Controller, Get } from '@nestjs/common';
import { QuickProduct } from './quick-product.schema';
import { QuickProductService } from './quick-product.service';

@Controller('quick-products')
export class QuickProductController {
  constructor(private readonly quickProductService: QuickProductService) {}

  @Get()
  findAll(): Promise<QuickProduct[]> {
    return this.quickProductService.findAll();
  }
}
