import { Module } from '@nestjs/common';
import { AuctionLifecycleScheduler } from './auction-lifecycle.scheduler.js';

@Module({
  providers: [AuctionLifecycleScheduler],
  exports: [AuctionLifecycleScheduler],
})
export class AuctionLifecycleModule {}
