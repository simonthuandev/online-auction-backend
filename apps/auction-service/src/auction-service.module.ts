import { Module } from '@nestjs/common';
import { AuctionServiceController } from './auction-service.controller.js';
import { AuctionServiceService } from './auction-service.service.js';

@Module({
  imports: [],
  controllers: [AuctionServiceController],
  providers: [AuctionServiceService],
})
export class AuctionServiceModule {}
