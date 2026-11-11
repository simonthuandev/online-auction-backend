import {
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpHandlers, EventHandlers, type AuthRequest } from '@app/common';
import { AuctionQueryService } from './auction/query/auction-query.service.js';
import { AuctionCreateService } from './auction/create/auction-create.service.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly auctionQuery: AuctionQueryService,
    private readonly auctionCreate: AuctionCreateService,
  ) {}

  onModuleInit() {
    this.http.register('auction_get__api_auctions', async (request: AuthRequest) => {
      return this.auctionQuery.listAuctions(request.query || {});
    });

    this.http.register('auction_post__api_auctions', async (request: AuthRequest) => {
      const sellerId = request.principal?.sub;
      if (!sellerId) {
        throw new UnauthorizedException('Unauthenticated');
      }
      const idempotencyKey = String(
        request.headers['idempotency-key'] ||
          request.headers['Idempotency-Key'] ||
          '',
      );
      return this.auctionCreate.createAuction(
        sellerId,
        idempotencyKey,
        request.body,
      );
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
