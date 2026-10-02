import { Controller, Get } from '@nestjs/common';
import { AuctionServiceService } from './auction-service.service.js';

@Controller()
export class AuctionServiceController {
  constructor(private readonly auctionServiceService: AuctionServiceService) {}

  @Get()
  getHello(): string {
    return this.auctionServiceService.getHello();
  }
}
