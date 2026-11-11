import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import {
  AuctionCreateService,
  type CreateAuctionInput,
} from './auction-create.service.js';
import { AuctionReservationWorker } from './auction-reservation.worker.js';
import { loadEnv } from '../../../../../scripts/platform/env.mjs';
import {
  createPgDatabase,
  integrationEnabled,
} from '../../../../../tests/support/pg-database.js';
import {
  InternalResponseError,
  type Database,
  type InternalHttp,
} from '../../../../../libs/common/src/index.js';

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
  'Auction Create & Worker Reservation Integration',
  () => {
    let pool: pg.Pool;
    let db: Database;
    let createService: AuctionCreateService;
    let mockInternalHttp: {
      reserveProduct: ReturnType<typeof vi.fn>;
    };

    const runId = randomUUID();
    const createdAuctionIds: string[] = [];

    beforeAll(async () => {
      pool = new pg.Pool({
        connectionString: process.env.AUCTION_DATABASE_URL,
        max: 5,
      });
      db = createPgDatabase(pool);
      createService = new AuctionCreateService(db);
      mockInternalHttp = {
        reserveProduct: vi.fn(),
      };
    });

    afterAll(async () => {
      try {
        if (createdAuctionIds.length > 0) {
          await pool.query(
            'DELETE FROM "Auction" WHERE id = ANY($1::text[])',
            [createdAuctionIds],
          );
        }
        await pool.query(
          'DELETE FROM "IdempotencyRecord" WHERE "actorId" = $1',
          [runId],
        );
      } finally {
        await pool.end();
      }
    });

    it('ensures only one auction succeeds when two requests compete for the same product (409 conflict)', async () => {
      const productId = randomUUID();
      const input1: CreateAuctionInput = {
        productId,
        startingPrice: '100000',
        bidIncrement: '10000',
        startTime: new Date(Date.now() + 60000).toISOString(),
        endTime: new Date(Date.now() + 120000).toISOString(),
      };
      const input2: CreateAuctionInput = {
        productId,
        startingPrice: '200000',
        bidIncrement: '20000',
        startTime: new Date(Date.now() + 60000).toISOString(),
        endTime: new Date(Date.now() + 120000).toISOString(),
      };

      const result1 = await createService.createAuction(
        runId,
        `key-first-${randomUUID()}`,
        input1,
      );
      createdAuctionIds.push(result1.id);

      expect(result1.status).toBe('INITIALIZING');
      expect(result1.productId).toBe(productId);

      // Second request for the same product must fail with 409 Conflict due to Auction_one_open_per_product
      await expect(
        createService.createAuction(
          runId,
          `key-second-${randomUUID()}`,
          input2,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('worker retries after temporary 5xx or network error and recovers to PENDING', async () => {
      const productId = randomUUID();
      const input: CreateAuctionInput = {
        productId,
        startingPrice: '150000',
        bidIncrement: '15000',
        startTime: new Date(Date.now() + 60000).toISOString(),
        endTime: new Date(Date.now() + 120000).toISOString(),
      };

      const created = await createService.createAuction(
        runId,
        `key-retry-${randomUUID()}`,
        input,
      );
      createdAuctionIds.push(created.id);

      const worker = new AuctionReservationWorker(
        db,
        mockInternalHttp as unknown as InternalHttp,
      );

      // First tick: Temporary failure (500 Server Error)
      mockInternalHttp.reserveProduct.mockRejectedValueOnce(
        new InternalResponseError(500, 'Product service temporarily unavailable'),
      );

      await worker.processAuction({
        id: created.id,
        productId,
        sellerId: runId,
        createdAt: new Date(),
      });

      // Verify auction is STILL in INITIALIZING state
      const rowsAfterFailure = await db.query<{ status: string }>(
        'SELECT status FROM "Auction" WHERE id = $1',
        created.id,
      );
      expect(rowsAfterFailure[0]?.status).toBe('INITIALIZING');

      // Second tick: Service recovers, reserveProduct succeeds
      mockInternalHttp.reserveProduct.mockResolvedValueOnce({
        auctionId: created.id,
        productId,
        sellerId: runId,
        productTitle: 'Recovered Product Title',
        productThumbnail: 'https://example.com/thumb.jpg',
      });

      await worker.processAuction({
        id: created.id,
        productId,
        sellerId: runId,
        createdAt: new Date(),
      });

      // Verify auction transitioned to PENDING with title and thumbnail
      const rowsAfterSuccess = await db.query<{
        status: string;
        productTitle: string | null;
        productThumbnail: string | null;
      }>(
        'SELECT status, "productTitle", "productThumbnail" FROM "Auction" WHERE id = $1',
        created.id,
      );
      expect(rowsAfterSuccess[0]?.status).toBe('PENDING');
      expect(rowsAfterSuccess[0]?.productTitle).toBe('Recovered Product Title');
      expect(rowsAfterSuccess[0]?.productThumbnail).toBe(
        'https://example.com/thumb.jpg',
      );
    });

    it('handles two worker instances running concurrently without data corruption', async () => {
      const productId = randomUUID();
      const input: CreateAuctionInput = {
        productId,
        startingPrice: '500000',
        bidIncrement: '50000',
        startTime: new Date(Date.now() + 60000).toISOString(),
        endTime: new Date(Date.now() + 120000).toISOString(),
      };

      const created = await createService.createAuction(
        runId,
        `key-parallel-${randomUUID()}`,
        input,
      );
      createdAuctionIds.push(created.id);

      const worker1 = new AuctionReservationWorker(
        db,
        mockInternalHttp as unknown as InternalHttp,
      );
      const worker2 = new AuctionReservationWorker(
        db,
        mockInternalHttp as unknown as InternalHttp,
      );

      mockInternalHttp.reserveProduct.mockResolvedValue({
        auctionId: created.id,
        productId,
        sellerId: runId,
        productTitle: 'Concurrent Safe Product',
        productThumbnail: null,
      });

      // Run both workers concurrently
      await Promise.all([
        worker1.processAuction({
          id: created.id,
          productId,
          sellerId: runId,
          createdAt: new Date(),
        }),
        worker2.processAuction({
          id: created.id,
          productId,
          sellerId: runId,
          createdAt: new Date(),
        }),
      ]);

      const rows = await db.query<{
        status: string;
        productTitle: string | null;
        version: number;
      }>(
        'SELECT status, "productTitle", version FROM "Auction" WHERE id = $1',
        created.id,
      );

      expect(rows[0]?.status).toBe('PENDING');
      expect(rows[0]?.productTitle).toBe('Concurrent Safe Product');
      expect(rows[0]?.version).toBe(0);
    });
  },
);
