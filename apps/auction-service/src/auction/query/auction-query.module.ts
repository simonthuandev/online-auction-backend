import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AuctionQueryService } from './auction-query.service.js';

@Module({
  imports: [PrismaModule],
  providers: [AuctionQueryService],
  exports: [AuctionQueryService],
})
export class AuctionQueryModule {}
