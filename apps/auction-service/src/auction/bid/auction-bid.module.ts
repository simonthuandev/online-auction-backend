import { Module } from '@nestjs/common';
import { AuctionBidService } from './auction-bid.service.js';

@Module({
  providers: [AuctionBidService],
  exports: [AuctionBidService],
})
export class AuctionBidModule {}
