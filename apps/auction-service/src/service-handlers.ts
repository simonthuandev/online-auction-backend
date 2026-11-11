import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers, type AuthRequest } from '@app/common';
import { AuctionQueryService } from './auction/query/auction-query.service.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly auctionQuery: AuctionQueryService,
  ) {}

  onModuleInit() {
    this.http.register('auction_get__api_auctions', async (request: AuthRequest) => {
      return this.auctionQuery.listAuctions(request.query || {});
    });

    this.http.register('auction_get__api_auctions_id', async (request: AuthRequest) => {
      return this.auctionQuery.getAuctionById(String(request.params.id));
    });

    this.http.register(
      'auction_get__api_auctions_id_bids',
      async (request: AuthRequest) => {
        return this.auctionQuery.getAuctionBids(
          String(request.params.id),
          request.query || {},
        );
      },
    );
  }
}
