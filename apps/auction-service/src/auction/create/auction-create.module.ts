import { Module } from '@nestjs/common';
import { AuctionCreateService } from './auction-create.service.js';
import { AuctionReservationWorker } from './auction-reservation.worker.js';

@Module({
  providers: [AuctionCreateService, AuctionReservationWorker],
  exports: [AuctionCreateService, AuctionReservationWorker],
})
export class AuctionCreateModule {}
