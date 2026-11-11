import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AuctionLifecycleScheduler } from './auction-lifecycle.scheduler.js';
import { loadEnv } from '../../../../../scripts/platform/env.mjs';
import {
  createPgDatabase,
  integrationEnabled,
} from '../../../../../tests/support/pg-database.js';
import {
  type Database,
  type Realtime,
} from '../../../../../libs/common/src/index.js';

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
  'Auction Lifecycle Scheduler Integration',
  () => {
    let pool: pg.Pool;
    let db: Database;
    let mockRealtime: {
      publishAuctionStatus: ReturnType<typeof vi.fn>;
    };

    const runId = randomUUID();
    const createdAuctionIds: string[] = [];

    beforeAll(async () => {
      pool = new pg.Pool({
        connectionString: process.env.AUCTION_DATABASE_URL,
        max: 5,
      });
      db = createPgDatabase(pool);
      mockRealtime = {
        publishAuctionStatus: vi.fn(),
      };
    });

    afterAll(async () => {
      try {
        if (createdAuctionIds.length > 0) {
          await pool.query(
            'DELETE FROM "OutboxEvent" WHERE "aggregateId" = ANY($1::text[])',
            [createdAuctionIds],
          );
          await pool.query(
            'DELETE FROM "Auction" WHERE id = ANY($1::text[])',
            [createdAuctionIds],
          );
        }
      } finally {
        await pool.end();
      }
    });

    async function createTestAuction(overrides: {
      status: string;
      startTime: Date;
      endTime: Date;
      version?: number;
      leadingBidderId?: string | null;
      currentPrice?: string;
    }): Promise<string> {
      const id = randomUUID();
      const productId = randomUUID();
      const sellerId = runId;
      const status = overrides.status;
      const startTime = overrides.startTime.toISOString();
      const endTime = overrides.endTime.toISOString();
      const version = overrides.version ?? 0;
      const startingPrice = '100000';
      const currentPrice = overrides.currentPrice ?? '100000';
      const bidIncrement = '10000';
      const leadingBidderId = overrides.leadingBidderId ?? null;

      await pool.query(
        `INSERT INTO "Auction" (
          id, "productId", "sellerId", "productTitle", "productThumbnail",
          "startingPrice", "currentPrice", "bidIncrement", currency,
          "startTime", "endTime", status, "leadingBidderId", version,
          "initializationRequest", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, 'Integration Test Product', 'https://example.com/thumb.jpg',
          $4::numeric, $5::numeric, $6::numeric, 'VND',
          $7::timestamp, $8::timestamp, $9::"AuctionStatus", $10, $11,
          '{}'::jsonb, timezone('UTC', now()), timezone('UTC', now())
        )`,
        [
          id,
          productId,
          sellerId,
          startingPrice,
          currentPrice,
          bidIncrement,
          startTime,
          endTime,
          status,
          leadingBidderId,
          version,
        ],
      );

      createdAuctionIds.push(id);
      return id;
    }

    it('handles two scheduler instances running concurrently without duplicate starts', async () => {
      const id1 = await createTestAuction({
        status: 'PENDING',
        startTime: new Date(Date.now() - 60000), // 1 min ago
        endTime: new Date(Date.now() + 60000), // 1 min in future
      });
      const id2 = await createTestAuction({
        status: 'PENDING',
        startTime: new Date(Date.now() - 50000),
        endTime: new Date(Date.now() + 60000),
      });

      const scheduler1 = new AuctionLifecycleScheduler(
        db,
        mockRealtime as unknown as Realtime,
      );
      const scheduler2 = new AuctionLifecycleScheduler(
        db,
        mockRealtime as unknown as Realtime,
      );

      // Run both schedulers concurrently on pending auctions
      const [count1, count2] = await Promise.all([
        scheduler1.startPendingAuctions(),
        scheduler2.startPendingAuctions(),
      ]);

      expect(count1 + count2).toBe(2);

      // Verify each auction has exactly 1 OutboxEvent for started
      const { rows: events } = await pool.query<{
        aggregateId: string;
        aggregateVersion: number;
        routingKey: string;
      }>(
        `SELECT "aggregateId", "aggregateVersion", "routingKey"
         FROM "OutboxEvent"
         WHERE "aggregateId" = ANY($1::text[])
         ORDER BY "aggregateVersion" ASC`,
        [[id1, id2]],
      );

      expect(events).toHaveLength(2);
      expect(events[0].routingKey).toBe('auction.started');
      expect(events[0].aggregateVersion).toBe(1);
      expect(events[1].routingKey).toBe('auction.started');
      expect(events[1].aggregateVersion).toBe(1);

      // Verify both auctions are ACTIVE with version 1
      const { rows: auctions } = await pool.query<{ id: string; status: string; version: number }>(
        `SELECT id, status, version FROM "Auction" WHERE id = ANY($1::text[])`,
        [[id1, id2]],
      );
      expect(auctions.every((a) => a.status === 'ACTIVE' && a.version === 1)).toBe(true);
    });

    it('rolls back atomic state and outbox when transition transaction encounters failure', async () => {
      const auctionId = await createTestAuction({
        status: 'PENDING',
        startTime: new Date(Date.now() - 30000),
        endTime: new Date(Date.now() + 60000),
        version: 0,
      });

      // Simulate a failed transaction attempt
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(
            `UPDATE "Auction" SET status = 'ACTIVE', version = 1 WHERE id = $1`,
            auctionId,
          );
          throw new Error('Simulated failure during business transition');
        }),
      ).rejects.toThrow('Simulated failure during business transition');

      // Verify auction is still PENDING with version 0
      const { rows: auctions } = await pool.query<{ status: string; version: number }>(
        `SELECT status, version FROM "Auction" WHERE id = $1`,
        [auctionId],
      );
      expect(auctions[0].status).toBe('PENDING');
      expect(auctions[0].version).toBe(0);

      // Verify no OutboxEvent exists
      const { rows: outbox } = await pool.query(
        `SELECT id FROM "OutboxEvent" WHERE "aggregateId" = $1`,
        [auctionId],
      );
      expect(outbox).toHaveLength(0);
    });

    it('recovers expired auctions after server restart by processing started then ended in order', async () => {
      // Simulate an auction created before server downtime:
      // startTime was 10 mins ago, endTime was 5 mins ago.
      // Server just booted up and auction is still in PENDING.
      const auctionId = await createTestAuction({
        status: 'PENDING',
        startTime: new Date(Date.now() - 10 * 60 * 1000),
        endTime: new Date(Date.now() - 5 * 60 * 1000),
        leadingBidderId: '10000000-0000-4000-8000-000000000003',
        currentPrice: '250000',
        version: 0,
      });

      const scheduler = new AuctionLifecycleScheduler(
        db,
        mockRealtime as unknown as Realtime,
      );

      // One tick: starts pending auction (-> ACTIVE, v1) then ends active auction (-> ENDED, v2)
      await scheduler.processTick();

      // Verify final auction state in DB
      const { rows: auctions } = await pool.query<{
        status: string;
        winnerId: string | null;
        finalPrice: string | null;
        version: number;
      }>(
        `SELECT status, "winnerId", "finalPrice"::text, version FROM "Auction" WHERE id = $1`,
        [auctionId],
      );

      expect(auctions[0].status).toBe('ENDED');
      expect(auctions[0].winnerId).toBe('10000000-0000-4000-8000-000000000003');
      expect(auctions[0].finalPrice).toBe('250000.00');
      expect(auctions[0].version).toBe(2);

      // Verify outbox has both started and ended in chronological version order
      const { rows: events } = await pool.query<{
        aggregateVersion: number;
        routingKey: string;
      }>(
        `SELECT "aggregateVersion", "routingKey"
         FROM "OutboxEvent"
         WHERE "aggregateId" = $1
         ORDER BY "aggregateVersion" ASC`,
        [auctionId],
      );

      expect(events).toHaveLength(2);
      expect(events[0].aggregateVersion).toBe(1);
      expect(events[0].routingKey).toBe('auction.started');
      expect(events[1].aggregateVersion).toBe(2);
      expect(events[1].routingKey).toBe('auction.ended');
    });
  },
);
