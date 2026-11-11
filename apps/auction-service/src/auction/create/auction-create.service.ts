import {
  Injectable,
  Inject,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PLATFORM_DB,
  withIdempotency,
  type Database,
} from '@app/common';
import {
  type AuctionDto,
  formatDecimal,
  formatDate,
} from '../query/auction-query.service.js';

export interface CreateAuctionInput {
  productId: string;
  startingPrice: string;
  bidIncrement: string;
  startTime: string;
  endTime: string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_REGEX = /^(0|[1-9][0-9]{0,15})$/;

interface AuctionRow {
  id: string;
  productId: string;
  sellerId: string;
  productTitle: string | null;
  productThumbnail: string | null;
  startingPrice: string;
  currentPrice: string;
  bidIncrement: string;
  currency: string;
  startTime: Date | string;
  endTime: Date | string;
  status: 'INITIALIZING' | 'PENDING' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
  version: number;
  winnerId: string | null;
  finalPrice: string | null;
}

@Injectable()
export class AuctionCreateService {
  constructor(@Inject(PLATFORM_DB) private readonly db: Database) {}

  async createAuction(
    sellerId: string,
    idempotencyKey: string,
    body: CreateAuctionInput,
  ): Promise<AuctionDto> {
    if (!sellerId) {
      throw new UnauthorizedException('Unauthenticated');
    }

    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    this.validateInput(body);

    const startDate = new Date(body.startTime);
    const endDate = new Date(body.endTime);

    try {
      const { response } = await withIdempotency<AuctionDto>(
        this.db,
        sellerId,
        'auction_post__api_auctions',
        idempotencyKey,
        body,
        202,
        async (tx) => {
          // Compare with database UTC time (Decision #3 & Technical Convention 3.1 #2)
          const timeRows = await tx.query<{ dbNow: Date | string }>(
            "SELECT timezone('UTC', now()) as \"dbNow\"",
          );
          const dbNow = new Date(timeRows[0]!.dbNow).getTime();

          if (startDate.getTime() < dbNow - 5000) {
            throw new BadRequestException(
              'startTime must be at or after current time (-5s tolerance)',
            );
          }

          if (endDate.getTime() <= startDate.getTime()) {
            throw new BadRequestException('endTime must be after startTime');
          }

          const auctionId = randomUUID();

          const rows = await tx.query<AuctionRow>(
            `INSERT INTO "Auction" (
              "id",
              "productId",
              "sellerId",
              "productTitle",
              "productThumbnail",
              "startingPrice",
              "currentPrice",
              "bidIncrement",
              "currency",
              "startTime",
              "endTime",
              "status",
              "version",
              "initializationRequest",
              "createdAt",
              "updatedAt"
            ) VALUES (
              $1,
              $2,
              $3,
              NULL,
              NULL,
              $4::numeric,
              $4::numeric,
              $5::numeric,
              'VND',
              $6::timestamp,
              $7::timestamp,
              'INITIALIZING',
              0,
              $8::jsonb,
              timezone('UTC', now()),
              timezone('UTC', now())
            ) RETURNING
              "id",
              "productId",
              "sellerId",
              "productTitle",
              "productThumbnail",
              "startingPrice"::text,
              "currentPrice"::text,
              "bidIncrement"::text,
              "currency",
              "startTime",
              "endTime",
              "status",
              "version",
              "winnerId",
              "finalPrice"::text`,
            auctionId,
            body.productId,
            sellerId,
            body.startingPrice,
            body.bidIncrement,
            startDate.toISOString(),
            endDate.toISOString(),
            JSON.stringify({
              productId: body.productId,
              sellerId,
              startingPrice: body.startingPrice,
              bidIncrement: body.bidIncrement,
              startTime: body.startTime,
              endTime: body.endTime,
            }),
          );

          const row = rows[0]!;
          return {
            id: row.id,
            productId: row.productId,
            sellerId: row.sellerId,
            productTitle: null,
            productThumbnail: null,
            startingPrice: formatDecimal(row.startingPrice),
            currentPrice: formatDecimal(row.currentPrice),
            bidIncrement: formatDecimal(row.bidIncrement),
            currency: 'VND',
            startTime: formatDate(row.startTime),
            endTime: formatDate(row.endTime),
            status: 'INITIALIZING',
            version: 0,
            winnerId: null,
            finalPrice: null,
          };
        },
      );

      return response;
    } catch (err: unknown) {
      const code =
        (err as { code?: string; meta?: { code?: string } })?.meta?.code ||
        (err as { code?: string })?.code;
      if (code === '23505' || code === 'P2002') {
        throw new ConflictException(
          'Product already has an open auction (INITIALIZING, PENDING, or ACTIVE)',
        );
      }
      if (code === '23514') {
        throw new BadRequestException('Auction violates price or time constraints');
      }
      throw err;
    }
  }

  private validateInput(body: CreateAuctionInput): void {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Invalid request body');
    }

    if (!body.productId || !UUID_REGEX.test(body.productId)) {
      throw new BadRequestException('Invalid productId format');
    }

    // Quyết định #6: Tiền nguyên dương dạng string, > 0
    if (
      !body.startingPrice ||
      !INTEGER_REGEX.test(body.startingPrice) ||
      BigInt(body.startingPrice) <= 0n
    ) {
      throw new BadRequestException('startingPrice must be greater than 0');
    }

    if (
      !body.bidIncrement ||
      !INTEGER_REGEX.test(body.bidIncrement) ||
      BigInt(body.bidIncrement) <= 0n
    ) {
      throw new BadRequestException('bidIncrement must be greater than 0');
    }

    // Quyết định #3: startTime >= now - 5s, endTime > startTime
    const startDate = new Date(body.startTime);
    const endDate = new Date(body.endTime);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new BadRequestException('Invalid date format for startTime or endTime');
    }

    if (endDate.getTime() <= startDate.getTime()) {
      throw new BadRequestException('endTime must be after startTime');
    }

    if (startDate.getTime() < Date.now() - 5000) {
      throw new BadRequestException(
        'startTime must be at or after current time (-5s tolerance)',
      );
    }
  }
}
