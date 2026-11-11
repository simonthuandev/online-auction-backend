import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../../../../scripts/platform/env.mjs';
import {
  createPgDatabase,
  integrationEnabled,
  cleanupRunData,
} from '../../../../tests/support/pg-database.js';
import { LifecycleConsumer } from './lifecycle.consumer.js';
import { LifecycleRepository } from './lifecycle.repository.js';
import type { AuctionEndedEvent } from './lifecycle.types.js';

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
  'Product Lifecycle Consumer Integration - Atomicity, Rollback & Replay',
  () => {
    const runId = randomUUID();
    const pool = new pg.Pool({
      connectionString: process.env.PRODUCT_DATABASE_URL,
      max: 5,
    });
    const db = createPgDatabase(pool);
    const repository = new LifecycleRepository();
    const consumer = new LifecycleConsumer(repository);

    const createdProductIds: string[] = [];
    const createdCategoryIds: string[] = [];

    afterAll(async () => {
      try {
        if (createdProductIds.length > 0) {
          await pool.query('DELETE FROM "ProductImage" WHERE "productId" = ANY($1)', [
            createdProductIds,
          ]);
          await pool.query('DELETE FROM "Product" WHERE "id" = ANY($1)', [
            createdProductIds,
          ]);
        }
        if (createdCategoryIds.length > 0) {
          await pool.query('DELETE FROM "Category" WHERE "id" = ANY($1)', [
            createdCategoryIds,
          ]);
        }
        await cleanupRunData(pool, runId);
      } finally {
        await pool.end();
      }
    });

    const createTestCategory = async () => {
      const categoryId = randomUUID();
      await pool.query(
        'INSERT INTO "Category" ("id", "name", "description", "createdAt") VALUES ($1, $2, $3, now())',
        [categoryId, `Category-${randomUUID()}`, 'Integration Test Category'],
      );
      createdCategoryIds.push(categoryId);
      return categoryId;
    };

    const createTestProduct = async (
      categoryId: string,
      status: 'READY' | 'RESERVED' | 'IN_AUCTION' | 'SOLD',
      reservedAuctionId: string | null = null,
      lastAuctionVersion = 0,
    ) => {
      const productId = randomUUID();
      const sellerId = randomUUID();
      const snapshot = reservedAuctionId
        ? JSON.stringify({
            productTitle: 'Lifecycle Test Product',
            productThumbnail: 'https://cdn.example.test/product.jpg',
          })
        : null;

      await pool.query(
        `INSERT INTO "Product" (
          "id", "sellerId", "categoryId", "title", "description",
          "condition", "status", "reservedAuctionId", "reservationSnapshot",
          "lastAuctionVersion", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2, $3, $4, $5,
          'NEW'::"ProductCondition", $6::"ProductStatus", $7, $8::jsonb,
          $9, now(), now()
        )`,
        [
          productId,
          sellerId,
          categoryId,
          'Lifecycle Test Product',
          'Integration product description',
          status,
          reservedAuctionId,
          snapshot,
          lastAuctionVersion,
        ],
      );
      createdProductIds.push(productId);
      return { productId, sellerId };
    };

    it('khi handler lỗi sau khi ghi, ProcessedEvent và thay đổi product rollback cùng nhau', async () => {
      const categoryId = await createTestCategory();
      const auctionId = randomUUID();
      const { productId, sellerId } = await createTestProduct(
        categoryId,
        'IN_AUCTION',
        auctionId,
        1,
      );

      const eventId = randomUUID();
      const consumerName = `queue.product.auction-events:${runId}`;
      const endedEvent: AuctionEndedEvent = {
        eventId,
        eventName: 'auction.ended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: auctionId,
        aggregateVersion: 2,
        correlationId: randomUUID(),
        payload: {
          auctionId,
          productId,
          productTitle: 'Lifecycle Test Product',
          productThumbnail: 'https://cdn.example.test/product.jpg',
          sellerId,
          winnerId: randomUUID(),
          finalPrice: '3000000',
          currency: 'VND',
          endedAt: new Date().toISOString(),
        },
      };

      // Giả lập transaction consumer của platform: ghi ProcessedEvent + gọi consumer + gặp lỗi sau khi ghi
      await expect(
        db.transaction(async (tx) => {
          await tx.query(
            'INSERT INTO "ProcessedEvent" ("consumerName", "eventId") VALUES ($1, $2)',
            consumerName,
            eventId,
          );
          await consumer.handleAuctionEnded(tx, endedEvent);
          // Lỗi sau khi ghi để kiểm tra atomicity và rollback
          throw new Error('SIMULATED_TRANSIENT_FAILURE');
        }),
      ).rejects.toThrow('SIMULATED_TRANSIENT_FAILURE');

      // Kiểm tra ProcessedEvent: không tồn tại vì đã rollback
      const processedResult = await pool.query(
        'SELECT * FROM "ProcessedEvent" WHERE "consumerName" = $1 AND "eventId" = $2',
        [consumerName, eventId],
      );
      expect(processedResult.rowCount).toBe(0);

      // Kiểm tra Product: vẫn giữ trạng thái cũ IN_AUCTION và version 1 vì đã rollback cùng nhau
      const productResult = await pool.query<{
        status: string;
        lastAuctionVersion: number;
        reservedAuctionId: string | null;
      }>('SELECT "status", "lastAuctionVersion", "reservedAuctionId" FROM "Product" WHERE "id" = $1', [
        productId,
      ]);
      expect(productResult.rowCount).toBe(1);
      expect(productResult.rows[0].status).toBe('IN_AUCTION');
      expect(productResult.rows[0].lastAuctionVersion).toBe(1);
      expect(productResult.rows[0].reservedAuctionId).toBe(auctionId);
    });

    it('replay auction.ended không đổi trạng thái product (idempotent)', async () => {
      const categoryId = await createTestCategory();
      const auctionId = randomUUID();
      const { productId, sellerId } = await createTestProduct(
        categoryId,
        'IN_AUCTION',
        auctionId,
        1,
      );

      const eventId = randomUUID();
      const consumerName = `queue.product.auction-events:${runId}`;
      const endedEvent: AuctionEndedEvent = {
        eventId,
        eventName: 'auction.ended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: auctionId,
        aggregateVersion: 2,
        correlationId: randomUUID(),
        payload: {
          auctionId,
          productId,
          productTitle: 'Lifecycle Test Product',
          productThumbnail: 'https://cdn.example.test/product.jpg',
          sellerId,
          winnerId: randomUUID(),
          finalPrice: '5000000',
          currency: 'VND',
          endedAt: new Date().toISOString(),
        },
      };

      // Lần 1: xử lý thành công
      await db.transaction(async (tx) => {
        await tx.query(
          'INSERT INTO "ProcessedEvent" ("consumerName", "eventId") VALUES ($1, $2)',
          consumerName,
          eventId,
        );
        await consumer.handleAuctionEnded(tx, endedEvent);
      });

      // Xác nhận DB sau lần 1: đã chuyển sang SOLD, version 2
      const afterFirstRun = await pool.query<{
        status: string;
        lastAuctionVersion: number;
        reservedAuctionId: string | null;
      }>('SELECT "status", "lastAuctionVersion", "reservedAuctionId" FROM "Product" WHERE "id" = $1', [
        productId,
      ]);
      expect(afterFirstRun.rows[0].status).toBe('SOLD');
      expect(afterFirstRun.rows[0].lastAuctionVersion).toBe(2);
      expect(afterFirstRun.rows[0].reservedAuctionId).toBe(auctionId);

      // Lần 2: Replay cùng event (version 2 <= lastAuctionVersion 2)
      await db.transaction(async (tx) => {
        await consumer.handleAuctionEnded(tx, endedEvent);
      });

      // Xác nhận DB sau replay: không thay đổi trạng thái
      const afterReplay = await pool.query<{
        status: string;
        lastAuctionVersion: number;
        reservedAuctionId: string | null;
      }>('SELECT "status", "lastAuctionVersion", "reservedAuctionId" FROM "Product" WHERE "id" = $1', [
        productId,
      ]);
      expect(afterReplay.rows[0].status).toBe('SOLD');
      expect(afterReplay.rows[0].lastAuctionVersion).toBe(2);
      expect(afterReplay.rows[0].reservedAuctionId).toBe(auctionId);
    });

    it('ended không có winner chuyển READY và xóa reservedAuctionId / reservationSnapshot', async () => {
      const categoryId = await createTestCategory();
      const auctionId = randomUUID();
      const { productId, sellerId } = await createTestProduct(
        categoryId,
        'IN_AUCTION',
        auctionId,
        1,
      );

      const eventId = randomUUID();
      const endedNoWinnerEvent: AuctionEndedEvent = {
        eventId,
        eventName: 'auction.ended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: auctionId,
        aggregateVersion: 2,
        correlationId: randomUUID(),
        payload: {
          auctionId,
          productId,
          productTitle: 'Lifecycle Test Product',
          productThumbnail: 'https://cdn.example.test/product.jpg',
          sellerId,
          winnerId: null,
          finalPrice: null,
          currency: 'VND',
          endedAt: new Date().toISOString(),
        },
      };

      await db.transaction(async (tx) => {
        await consumer.handleAuctionEnded(tx, endedNoWinnerEvent);
      });

      const res = await pool.query<{
        status: string;
        lastAuctionVersion: number;
        reservedAuctionId: string | null;
        reservationSnapshot: unknown;
      }>(
        'SELECT "status", "lastAuctionVersion", "reservedAuctionId", "reservationSnapshot" FROM "Product" WHERE "id" = $1',
        [productId],
      );
      expect(res.rows[0].status).toBe('READY');
      expect(res.rows[0].lastAuctionVersion).toBe(2);
      expect(res.rows[0].reservedAuctionId).toBeNull();
      expect(res.rows[0].reservationSnapshot).toBeNull();
    });
  },
);
