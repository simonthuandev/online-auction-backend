import {
  Injectable,
  Inject,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  PLATFORM_DB,
  Realtime,
  enqueueEvent,
  type Database,
  type IntegrationEvent,
} from '@app/common';
import { formatDate } from '../query/auction-query.service.js';
import { computeAuctionEndResult } from './auction-lifecycle.domain.js';

export type AuctionStartedEvent = Extract<
  IntegrationEvent,
  { eventName: 'auction.started' }
>;
export type AuctionEndedEvent = Extract<
  IntegrationEvent,
  { eventName: 'auction.ended' }
>;

interface PendingAuctionRow {
  id: string;
  productId: string;
  sellerId: string;
  startTime: Date | string;
  endTime: Date | string;
  version: number;
}

interface ActiveAuctionRow {
  id: string;
  productId: string;
  sellerId: string;
  productTitle: string | null;
  productThumbnail: string | null;
  currentPrice: string;
  leadingBidderId: string | null;
  currency: string;
  version: number;
}

@Injectable()
export class AuctionLifecycleScheduler implements OnModuleInit, OnModuleDestroy {
  private intervalRef?: NodeJS.Timeout;
  private isProcessing = false;
  private readonly logger = new Logger(AuctionLifecycleScheduler.name);

  constructor(
    @Inject(PLATFORM_DB) private readonly db: Database,
    private readonly realtime: Realtime,
  ) {}

  onModuleInit() {
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  start(intervalMs = 1000): void {
    if (this.intervalRef) return;
    this.intervalRef = setInterval(() => {
      void this.processTick();
    }, intervalMs);
    this.intervalRef.unref();
    void this.processTick();
  }

  stop(): void {
    if (this.intervalRef) {
      clearInterval(this.intervalRef);
      this.intervalRef = undefined;
    }
  }

  async processTick(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;
    try {
      await this.startPendingAuctions();
      await this.endActiveAuctions();
    } catch (err) {
      this.logger.error('Error during auction lifecycle tick', err);
    } finally {
      this.isProcessing = false;
    }
  }

  async startPendingAuctions(): Promise<number> {
    const committedEvents: Array<{
      auctionId: string;
      event: AuctionStartedEvent;
      newVersion: number;
    }> = [];

    await this.db.transaction(async (tx) => {
      const candidates = await tx.query<PendingAuctionRow>(
        `SELECT
           id,
           "productId",
           "sellerId",
           "startTime",
           "endTime",
           version
         FROM "Auction"
         WHERE status = 'PENDING'
           AND "startTime" <= timezone('UTC', now())
         ORDER BY "startTime" ASC
         LIMIT 50
         FOR UPDATE SKIP LOCKED`,
      );

      for (const auction of candidates) {
        const newVersion = auction.version + 1;

        await tx.execute(
          `UPDATE "Auction"
           SET status = 'ACTIVE',
               version = $1,
               "updatedAt" = timezone('UTC', now())
           WHERE id = $2`,
          newVersion,
          auction.id,
        );

        const nowIso = new Date().toISOString();
        const event: AuctionStartedEvent = {
          eventId: randomUUID(),
          eventName: 'auction.started',
          schemaVersion: 1,
          occurredAt: nowIso,
          producer: 'auction',
          aggregateId: auction.id,
          aggregateVersion: newVersion,
          correlationId: randomUUID(),
          payload: {
            auctionId: auction.id,
            productId: auction.productId,
            sellerId: auction.sellerId,
            startTime: formatDate(auction.startTime),
            endTime: formatDate(auction.endTime),
          },
        };

        await enqueueEvent(tx, event);
        committedEvents.push({ auctionId: auction.id, event, newVersion });
      }
    });

    // Post-commit: emit realtime status (lỗi socket chỉ log)
    for (const item of committedEvents) {
      try {
        this.realtime.publishAuctionStatus(item.auctionId, {
          ...item.event.payload,
          status: 'ACTIVE',
          version: item.newVersion,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to emit realtime status for started auction ${item.auctionId}: ${String(err)}`,
        );
      }
    }

    return committedEvents.length;
  }

  async endActiveAuctions(): Promise<number> {
    const committedEvents: Array<{
      auctionId: string;
      event: AuctionEndedEvent;
      newVersion: number;
    }> = [];

    await this.db.transaction(async (tx) => {
      const candidates = await tx.query<ActiveAuctionRow>(
        `SELECT
           id,
           "productId",
           "sellerId",
           "productTitle",
           "productThumbnail",
           "currentPrice"::text as "currentPrice",
           "leadingBidderId",
           currency,
           version
         FROM "Auction"
         WHERE status = 'ACTIVE'
           AND "endTime" <= timezone('UTC', now())
         ORDER BY "endTime" ASC
         LIMIT 50
         FOR UPDATE SKIP LOCKED`,
      );

      for (const auction of candidates) {
        const newVersion = auction.version + 1;
        const { winnerId, finalPrice } = computeAuctionEndResult({
          leadingBidderId: auction.leadingBidderId,
          currentPrice: auction.currentPrice,
        });

        await tx.execute(
          `UPDATE "Auction"
           SET status = 'ENDED',
               "winnerId" = $1,
               "finalPrice" = $2::numeric,
               version = $3,
               "updatedAt" = timezone('UTC', now())
           WHERE id = $4`,
          winnerId,
          finalPrice,
          newVersion,
          auction.id,
        );

        const nowIso = new Date().toISOString();
        const event: AuctionEndedEvent = {
          eventId: randomUUID(),
          eventName: 'auction.ended',
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
            productThumbnail: auction.productThumbnail ?? null,
            sellerId: auction.sellerId,
            winnerId,
            finalPrice,
            currency: 'VND',
            endedAt: nowIso,
          },
        };

        await enqueueEvent(tx, event);
        committedEvents.push({ auctionId: auction.id, event, newVersion });
      }
    });

    // Post-commit: emit realtime status (lỗi socket chỉ log)
    for (const item of committedEvents) {
      try {
        this.realtime.publishAuctionStatus(item.auctionId, {
          ...item.event.payload,
          status: 'ENDED',
          version: item.newVersion,
        });
      } catch (err) {
        this.logger.warn(
          `Failed to emit realtime status for ended auction ${item.auctionId}: ${String(err)}`,
        );
      }
    }

    return committedEvents.length;
  }
}
