import { afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { NotificationConsumer } from './notification.consumer.js';
import { loadEnv } from '../../../../../scripts/platform/env.mjs';
import {
  createPgDatabase,
  integrationEnabled,
  cleanupRunData,
} from '../../../../../tests/support/pg-database.js';
import { Realtime, type IntegrationEvent } from '@app/common';

type BidPlacedEvent = Extract<IntegrationEvent, { eventName: 'bid.placed' }>;
type AuctionEndedEvent = Extract<IntegrationEvent, { eventName: 'auction.ended' }>;

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
  'NotificationConsumer Integration Tests (Idempotency, Rollback & Realtime)',
  () => {
    const runId = randomUUID();
    const pool = new pg.Pool({
      connectionString: process.env.NOTIFICATION_DATABASE_URL,
      max: 5,
    });
    const db = createPgDatabase(pool);

    const mockRealtime = {
      publishNotification: vi.fn(),
    };
    const consumer = new NotificationConsumer(
      mockRealtime as unknown as Realtime,
    );

    const createdEventIds: string[] = [];

    afterAll(async () => {
      try {
        for (const eventId of createdEventIds) {
          await pool.query('DELETE FROM "Notification" WHERE "sourceEventId" = $1', [
            eventId,
          ]);
        }
        await cleanupRunData(pool, runId);
      } finally {
        await pool.end();
      }
    });

    it('xử lý cùng event 2 lần -> chỉ 1 bản ghi trong DB và chỉ 1 lần phát socket', async () => {
      const eventId = randomUUID();
      createdEventIds.push(eventId);
      mockRealtime.publishNotification.mockClear();

      const event: BidPlacedEvent = {
        eventId,
        eventName: 'bid.placed',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: {
          auctionId: randomUUID(),
          productId: randomUUID(),
          productTitle: 'Điện thoại Vertu',
          newBidderId: randomUUID(),
          previousBidderId: randomUUID(),
          currentPrice: '50000000',
          currency: 'VND',
          bidTime: new Date().toISOString(),
        },
      };

      // Lần 1: xử lý trong transaction và chạy callback
      let effect1: (() => void) | void;
      await db.transaction(async (tx) => {
        effect1 = await consumer.handleBidPlaced(tx, event);
      });
      expect(typeof effect1).toBe('function');
      effect1!();

      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(1);

      // Lần 2: replay cùng event (cùng eventId)
      let effect2: (() => void) | void;
      await db.transaction(async (tx) => {
        effect2 = await consumer.handleBidPlaced(tx, event);
      });

      // Do ON CONFLICT DO NOTHING -> 0 dòng được insert -> effect2 là undefined
      expect(effect2).toBeUndefined();

      // Kiểm tra DB: Chỉ có đúng 1 bản ghi
      const { rows } = await pool.query(
        'SELECT * FROM "Notification" WHERE "sourceEventId" = $1',
        [eventId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(event.payload.previousBidderId);
      expect(rows[0].type).toBe('OUTBID');

      // Socket chỉ phát đúng 1 lần duy nhất từ lần 1
      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(1);
    });

    it('lỗi ghi trong transaction -> rollback, không có bản ghi và không phát socket', async () => {
      const eventId = randomUUID();
      createdEventIds.push(eventId);
      mockRealtime.publishNotification.mockClear();

      const event: BidPlacedEvent = {
        eventId,
        eventName: 'bid.placed',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: {
          auctionId: randomUUID(),
          productId: randomUUID(),
          productTitle: 'Vòng ngọc bích',
          newBidderId: randomUUID(),
          previousBidderId: randomUUID(),
          currentPrice: '10000000',
          currency: 'VND',
          bidTime: new Date().toISOString(),
        },
      };

      // Giả lập transaction bị rollback do lỗi giữa chừng
      await expect(
        db.transaction(async (tx) => {
          await consumer.handleBidPlaced(tx, event);
          throw new Error('SIMULATED_TRANSACTION_FAILURE');
        }),
      ).rejects.toThrow('SIMULATED_TRANSACTION_FAILURE');

      // Kiểm tra DB: Bản ghi không tồn tại do đã bị rollback
      const { rows } = await pool.query(
        'SELECT * FROM "Notification" WHERE "sourceEventId" = $1',
        [eventId],
      );
      expect(rows).toHaveLength(0);

      // Socket không được phát
      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();
    });

    it('callback chỉ chạy sau khi commit, không phát socket trong transaction', async () => {
      const eventId = randomUUID();
      createdEventIds.push(eventId);
      mockRealtime.publishNotification.mockClear();

      const event: AuctionEndedEvent = {
        eventId,
        eventName: 'auction.ended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: {
          auctionId: randomUUID(),
          productId: randomUUID(),
          productTitle: 'Bàn phím cơ',
          productThumbnail: null,
          sellerId: randomUUID(),
          winnerId: randomUUID(),
          finalPrice: '3000000',
          currency: 'VND',
          endedAt: new Date().toISOString(),
        },
      };

      let callback: (() => void) | void;

      await db.transaction(async (tx) => {
        callback = await consumer.handleAuctionEnded(tx, event);
        // Trong transaction: socket chưa hề được gọi
        expect(mockRealtime.publishNotification).not.toHaveBeenCalled();
      });

      // Sau khi transaction commit thành công:
      expect(typeof callback).toBe('function');
      callback!();

      // Socket được phát sau commit
      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(2);
    });

    it('socket ném lỗi không làm hỏng transaction hay ảnh hưởng bản ghi DB', async () => {
      const eventId = randomUUID();
      createdEventIds.push(eventId);

      // Giả lập socket ném lỗi
      mockRealtime.publishNotification.mockImplementationOnce(() => {
        throw new Error('SOCKET_CONNECTION_REFUSED');
      });

      const event: BidPlacedEvent = {
        eventId,
        eventName: 'bid.placed',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: {
          auctionId: randomUUID(),
          productId: randomUUID(),
          productTitle: 'Tai nghe Bluetooth',
          newBidderId: randomUUID(),
          previousBidderId: randomUUID(),
          currentPrice: '1500000',
          currency: 'VND',
          bidTime: new Date().toISOString(),
        },
      };

      let callback: (() => void) | void;
      await db.transaction(async (tx) => {
        callback = await consumer.handleBidPlaced(tx, event);
      });

      expect(typeof callback).toBe('function');
      // Chạy callback: lỗi socket bị bắt và không ném ra ngoài
      expect(() => callback!()).not.toThrow();

      // Bản ghi DB vẫn tồn tại hoàn chỉnh
      const { rows } = await pool.query(
        'SELECT * FROM "Notification" WHERE "sourceEventId" = $1',
        [eventId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(event.payload.previousBidderId);
    });
  },
);

