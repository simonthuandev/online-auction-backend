import { Controller, Get } from '@nestjs/common';
import { ProductServiceService } from './product-service.service.js';

@Controller()
export class ProductServiceController {
  constructor(private readonly productServiceService: ProductServiceService) {}

  @Get()
  getHello(): string {
    return this.productServiceService.getHello();
  }
}
