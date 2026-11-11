import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AuctionBidService } from './auction-bid.service.js';
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

describe.skipIf(!integrationEnabled)('Auction Bid Integration', () => {
  let pool: pg.Pool;
  let db: Database;
  let mockRealtime: {
    publishBidUpdate: ReturnType<typeof vi.fn>;
  };
  let bidService: AuctionBidService;

  const runId = randomUUID();
  const createdAuctionIds: string[] = [];
  const actorIds: string[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env.AUCTION_DATABASE_URL,
      max: 10,
    });
    db = createPgDatabase(pool);
    mockRealtime = {
      publishBidUpdate: vi.fn(),
    };
    bidService = new AuctionBidService(db, mockRealtime as unknown as Realtime);
  });

  afterAll(async () => {
    try {
      if (createdAuctionIds.length > 0) {
        await pool.query(
          'DELETE FROM "Bid" WHERE "auctionId" = ANY($1::text[])',
          [createdAuctionIds],
        );
        await pool.query(
          'DELETE FROM "OutboxEvent" WHERE "aggregateId" = ANY($1::text[])',
          [createdAuctionIds],
        );
        await pool.query(
          'DELETE FROM "Auction" WHERE id = ANY($1::text[])',
          [createdAuctionIds],
        );
      }
      if (actorIds.length > 0) {
        await pool.query(
          'DELETE FROM "IdempotencyRecord" WHERE "actorId" = ANY($1::text[])',
          [actorIds],
        );
      }
    } finally {
      await pool.end();
    }
  });

  async function createActiveAuction(overrides?: {
    startingPrice?: string;
    currentPrice?: string;
    bidIncrement?: string;
    leadingBidderId?: string | null;
    version?: number;
    sellerId?: string;
  }): Promise<string> {
    const id = randomUUID();
    const productId = randomUUID();
    const sellerId = overrides?.sellerId ?? randomUUID();
    const startingPrice = overrides?.startingPrice ?? '100000';
    const currentPrice = overrides?.currentPrice ?? '100000';
    const bidIncrement = overrides?.bidIncrement ?? '10000';
    const leadingBidderId = overrides?.leadingBidderId ?? null;
    const version = overrides?.version ?? 1;

    await pool.query(
      `INSERT INTO "Auction" (
        id, "productId", "sellerId", "productTitle", "productThumbnail",
        "startingPrice", "currentPrice", "bidIncrement", currency,
        "startTime", "endTime", status, "leadingBidderId", version,
        "initializationRequest", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, 'Integration Test Item', 'https://example.com/item.jpg',
        $4::numeric, $5::numeric, $6::numeric, 'VND',
        timezone('UTC', now()) - interval '1 hour',
        timezone('UTC', now()) + interval '1 hour',
        'ACTIVE'::"AuctionStatus", $7, $8,
        '{}'::jsonb, timezone('UTC', now()), timezone('UTC', now())
      )`,
      [
        id,
        productId,
        sellerId,
        startingPrice,
        currentPrice,
        bidIncrement,
        leadingBidderId,
        version,
      ],
    );

    createdAuctionIds.push(id);
    return id;
  }

  it('serializes concurrent bids on the same auction with row locking (FOR UPDATE)', async () => {
    const auctionId = await createActiveAuction({
      startingPrice: '100000',
      currentPrice: '100000',
      bidIncrement: '10000',
      version: 1,
    });

    const bidderA = randomUUID();
    const bidderB = randomUUID();
    actorIds.push(bidderA, bidderB);

    // Concurrently submit two bids with increasing amounts from different bidders
    const bid1 = bidService.placeBid(
      bidderA,
      auctionId,
      `key-concurrent-1-${runId}`,
      { amount: '120000' },
    );
    const bid2 = bidService.placeBid(
      bidderB,
      auctionId,
      `key-concurrent-2-${runId}`,
      { amount: '140000' },
    );

    const results = await Promise.allSettled([bid1, bid2]);

    // Both should either succeed or if 140000 landed first, 120000 would fail with 400.
    // In any order, the DB state must be consistent.
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    // Verify DB consistency
    const { rows: auctionRows } = await pool.query<{
      currentPrice: string;
      leadingBidderId: string;
      version: number;
    }>(
      `SELECT "currentPrice"::text, "leadingBidderId", version FROM "Auction" WHERE id = $1`,
      [auctionId],
    );

    const finalAuction = auctionRows[0];
    expect(finalAuction).toBeDefined();

    // Version must equal initial version + number of successful bids
    expect(finalAuction.version).toBe(1 + succeeded.length);

    // Verify Bid table contains exactly the successful bids
    const { rows: bidRows } = await pool.query<{
      bidderId: string;
      amount: string;
    }>(
      `SELECT "bidderId", amount::text FROM "Bid" WHERE "auctionId" = $1 ORDER BY "createdAt" ASC`,
      [auctionId],
    );
    expect(bidRows).toHaveLength(succeeded.length);

    // Outbox events match exactly the successful bids
    const { rows: outboxRows } = await pool.query<{
      aggregateVersion: number;
      routingKey: string;
    }>(
      `SELECT "aggregateVersion", "routingKey" FROM "OutboxEvent" WHERE "aggregateId" = $1 ORDER BY "aggregateVersion" ASC`,
      [auctionId],
    );
    expect(outboxRows).toHaveLength(succeeded.length);
    expect(outboxRows.every((e) => e.routingKey === 'bid.placed')).toBe(true);
  });

  it('replays same response for duplicate idempotency key without duplicate bid or second socket emit', async () => {
    const auctionId = await createActiveAuction({
      startingPrice: '100000',
      currentPrice: '100000',
      bidIncrement: '10000',
    });

    const bidderId = randomUUID();
    actorIds.push(bidderId);
    const idempKey = `idemp-replay-${runId}`;

    mockRealtime.publishBidUpdate.mockClear();

    // First call
    const firstRes = await bidService.placeBid(
      bidderId,
      auctionId,
      idempKey,
      { amount: '120000' },
    );

    expect(firstRes.amount).toBe('120000');
    expect(mockRealtime.publishBidUpdate).toHaveBeenCalledTimes(1);

    // Second call with same idempotency key and payload
    const secondRes = await bidService.placeBid(
      bidderId,
      auctionId,
      idempKey,
      { amount: '120000' },
    );

    expect(secondRes).toEqual(firstRes);

    // Verify no second socket emit
    expect(mockRealtime.publishBidUpdate).toHaveBeenCalledTimes(1);

    // Verify only 1 bid row exists in database
    const { rows: bids } = await pool.query(
      `SELECT id FROM "Bid" WHERE "auctionId" = $1`,
      [auctionId],
    );
    expect(bids).toHaveLength(1);
  });

  it('rolls back bid and does not emit socket when transaction fails', async () => {
    const auctionId = await createActiveAuction({
      startingPrice: '100000',
      currentPrice: '100000',
      bidIncrement: '10000',
    });

    const bidderId = randomUUID();
    actorIds.push(bidderId);
    const idempKey = `idemp-fail-${runId}`;

    mockRealtime.publishBidUpdate.mockClear();

    // Attempting a bid with invalid amount violating check rules
    await expect(
      bidService.placeBid(
        bidderId,
        auctionId,
        idempKey,
        { amount: '50000' }, // Below starting price 100000
      ),
    ).rejects.toThrow();

    // Verify no socket emit
    expect(mockRealtime.publishBidUpdate).not.toHaveBeenCalled();

    // Verify no bid persisted
    const { rows: bids } = await pool.query(
      `SELECT id FROM "Bid" WHERE "auctionId" = $1`,
      [auctionId],
    );
    expect(bids).toHaveLength(0);

    // Verify auction unchanged
    const { rows: auctions } = await pool.query<{ currentPrice: string }>(
      `SELECT "currentPrice"::text FROM "Auction" WHERE id = $1`,
      [auctionId],
    );
    expect(auctions[0].currentPrice).toBe('100000.00');
  });
});
