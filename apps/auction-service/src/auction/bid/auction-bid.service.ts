import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PLATFORM_DB,
  Realtime,
  withIdempotency,
  enqueueEvent,
  type Database,
  type IntegrationEvent,
} from '@app/common';
import {
  type BidDto,
  formatDecimal,
  formatDate,
} from '../query/auction-query.service.js';
import { validateBidRules } from './auction-bid.domain.js';

export interface PlaceBidInput {
  amount: string;
}

export type BidPlacedEvent = Extract<
  IntegrationEvent,
  { eventName: 'bid.placed' }
>;

interface LockedAuctionRow {
  id: string;
  productId: string;
  sellerId: string;
  productTitle: string | null;
  startingPrice: string;
  currentPrice: string;
  bidIncrement: string;
  currency: string;
  startTime: Date | string;
  endTime: Date | string;
  status: string;
  leadingBidderId: string | null;
  version: number;
  dbNow: Date | string;
}

interface InsertedBidRow {
  id: string;
  auctionId: string;
  bidderId: string;
  amount: string;
  createdAt: Date | string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_REGEX = /^(0|[1-9][0-9]{0,15})$/;

@Injectable()
export class AuctionBidService {
  private readonly logger = new Logger(AuctionBidService.name);

  constructor(
    @Inject(PLATFORM_DB) private readonly db: Database,
    private readonly realtime: Realtime,
  ) {}

  async placeBid(
    bidderId: string,
    auctionId: string,
    idempotencyKey: string,
    body: PlaceBidInput,
  ): Promise<BidDto> {
    if (!bidderId) {
      throw new UnauthorizedException('Unauthenticated');
    }

    if (
      !idempotencyKey ||
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.trim() === ''
    ) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    if (!auctionId || !UUID_REGEX.test(auctionId)) {
      throw new BadRequestException('Invalid auctionId format');
    }

    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Invalid request body');
    }

    // Quyết định #6: Tiền nguyên dương dạng string > 0
    if (
      !body.amount ||
      !INTEGER_REGEX.test(body.amount) ||
      BigInt(body.amount) <= 0n
    ) {
      throw new BadRequestException('amount must be greater than 0');
    }

    let executed = false;
    let socketPayload: { auctionId: string; payload: unknown } | null = null;

    // withIdempotency: đưa auctionId vào body băm để cùng key khác auction không nhầm
    const { response } = await withIdempotency<BidDto>(
      this.db,
      bidderId,
      'auction_post__api_auctions_id_bids',
      idempotencyKey,
      { auctionId, amount: body.amount },
      201,
      async (tx) => {
        executed = true;

        // Khóa dòng Auction và đọc giờ UTC của database
        const rows = await tx.query<LockedAuctionRow>(
          `SELECT
             id,
             "productId",
             "sellerId",
             "productTitle",
             "startingPrice"::text,
             "currentPrice"::text,
             "bidIncrement"::text,
             currency,
             "startTime",
             "endTime",
             status,
             "leadingBidderId",
             version,
             timezone('UTC', now()) as "dbNow"
           FROM "Auction"
           WHERE id = $1
           FOR UPDATE`,
          auctionId,
        );

        const auction = rows[0];
        if (!auction) {
          throw new NotFoundException('Auction not found');
        }

        // Áp dụng luật đấu giá theo Quyết định #4
        validateBidRules({
          bidderId,
          sellerId: auction.sellerId,
          status: auction.status,
          startTime: auction.startTime,
          endTime: auction.endTime,
          now: auction.dbNow,
          startingPrice: auction.startingPrice,
          currentPrice: auction.currentPrice,
          bidIncrement: auction.bidIncrement,
          leadingBidderId: auction.leadingBidderId,
          amount: body.amount,
        });

        // Insert Bid
        const bidId = randomUUID();
        const bidRows = await tx.query<InsertedBidRow>(
          `INSERT INTO "Bid" (
             id,
             "auctionId",
             "bidderId",
             amount,
             "createdAt"
           ) VALUES (
             $1,
             $2,
             $3,
             $4::numeric,
             timezone('UTC', now())
           ) RETURNING
             id,
             "auctionId",
             "bidderId",
             amount::text,
             "createdAt"`,
          bidId,
          auctionId,
          bidderId,
          body.amount,
        );

        const newVersion = auction.version + 1;

        // Cập nhật currentPrice, leadingBidderId, version+1
        await tx.execute(
          `UPDATE "Auction"
           SET "currentPrice" = $1::numeric,
               "leadingBidderId" = $2,
               version = $3,
               "updatedAt" = timezone('UTC', now())
           WHERE id = $4`,
          body.amount,
          bidderId,
          newVersion,
          auctionId,
        );

        // Enqueue event 'bid.placed'
        const nowIso = new Date().toISOString();
        const event: BidPlacedEvent = {
          eventId: randomUUID(),
          eventName: 'bid.placed',
          schemaVersion: 1,
          occurredAt: nowIso,
          producer: 'auction',
          aggregateId: auction.id,
          aggregateVersion: newVersion,
          correlationId: randomUUID(),
          payload: {
            auctionId: auction.id,
            productId: auction.productId,
            productTitle: auction.productTitle || '',
            newBidderId: bidderId,
            previousBidderId: auction.leadingBidderId ?? null,
            currentPrice: formatDecimal(body.amount),
            currency: 'VND',
            bidTime: nowIso,
          },
        };

        await enqueueEvent(tx, event);

        socketPayload = {
          auctionId: auction.id,
          payload: {
            ...event.payload,
            version: newVersion,
          },
        };

        const insertedBid = bidRows[0]!;
        return {
          id: insertedBid.id,
          auctionId: insertedBid.auctionId,
          bidderId: insertedBid.bidderId,
          amount: formatDecimal(insertedBid.amount),
          createdAt: formatDate(insertedBid.createdAt),
        };
      },
    );

    // Chỉ emit publishBidUpdate khi cờ executed bật, sau commit (Quy ước 3.1 #8)
    if (executed && socketPayload) {
      try {
        this.realtime.publishBidUpdate(
          (socketPayload as { auctionId: string; payload: unknown }).auctionId,
          (socketPayload as { auctionId: string; payload: unknown }).payload,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to emit bid realtime update for auction ${auctionId}: ${String(err)}`,
        );
      }
    }

    return response;
  }
}
