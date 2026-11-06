import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { OrderConsumer } from './order.consumer.js';
import { loadEnv } from '../../../../scripts/platform/env.mjs';
import { createPgDatabase, integrationEnabled } from '../../../../tests/support/pg-database.js';
import { type IntegrationEvent } from '../../../../libs/common/src/index.js';

type AuctionEndedEvent = Extract<IntegrationEvent, { eventName: 'auction.ended' }>;

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
  'OrderConsumer Integration - Idempotent & Rollback',
  () => {
    const pool = new pg.Pool({
      connectionString: process.env.ORDER_DATABASE_URL,
      max: 5,
    });
    const db = createPgDatabase(pool);
    const consumer = new OrderConsumer();

    const createdAuctionIds: string[] = [];

    afterAll(async () => {
      try {
        for (const auctionId of createdAuctionIds) {
          await pool.query('DELETE FROM "Order" WHERE "auctionId" = $1', [auctionId]);
        }
      } finally {
        await pool.end();
      }
    });

    it('ensures duplicate event replays do not create a second order (idempotent)', async () => {
      const auctionId = randomUUID();
      createdAuctionIds.push(auctionId);

      const event: AuctionEndedEvent = {
        eventId: randomUUID(),
        eventName: 'auction.ended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: auctionId,
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: {
          auctionId,
          productId: randomUUID(),
          productTitle: 'Vintage Watch',
          productThumbnail: null,
          sellerId: randomUUID(),
          winnerId: randomUUID(),
          finalPrice: '5000000',
          currency: 'VND',
          endedAt: new Date().toISOString(),
        },
      };

      // Chạy lần 1 trong transaction
      await db.transaction(async (tx) => {
        await consumer.handleAuctionEnded(tx, event);
      });

      // Chạy lần 2 (replay cùng event)
      await db.transaction(async (tx) => {
        await consumer.handleAuctionEnded(tx, event);
      });

      // Kiểm tra database: chỉ có đúng 1 bản ghi cho auctionId này
      const result = await pool.query(
        'SELECT * FROM "Order" WHERE "auctionId" = $1',
        [auctionId],
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0].status).toBe('PENDING_PAYMENT');
      expect(result.rows[0].buyerId).toBe(event.payload.winnerId);
    });

    it('rolls back database write when an error occurs inside the transaction', async () => {
      const auctionId = randomUUID();
      createdAuctionIds.push(auctionId);

      const event: AuctionEndedEvent = {
        eventId: randomUUID(),
        eventName: 'auction.ended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: auctionId,
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: {
          auctionId,
          productId: randomUUID(),
          productTitle: 'Gold Ring',
          productThumbnail: null,
          sellerId: randomUUID(),
          winnerId: randomUUID(),
          finalPrice: '10000000',
          currency: 'VND',
          endedAt: new Date().toISOString(),
        },
      };

      // Giả lập transaction bị lỗi sau khi ghi
      await expect(
        db.transaction(async (tx) => {
          await consumer.handleAuctionEnded(tx, event);
          throw new Error('SIMULATED_DB_FAILURE');
        }),
      ).rejects.toThrow('SIMULATED_DB_FAILURE');

      // Xác nhận: bản ghi không hề tồn tại trong DB do đã rollback
      const result = await pool.query(
        'SELECT * FROM "Order" WHERE "auctionId" = $1',
        [auctionId],
      );
      expect(result.rowCount).toBe(0);
    });
  },
);
