import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  shouldStartAuction,
  shouldEndAuction,
  computeAuctionEndResult,
} from './auction-lifecycle.domain.js';
import { AuctionLifecycleScheduler } from './auction-lifecycle.scheduler.js';
import type { Database, Transaction, Realtime } from '../../../../../libs/common/src/index.js';

describe('Auction Lifecycle (Unit Tests)', () => {
  describe('Pure Domain Functions', () => {
    describe('shouldStartAuction', () => {
      it('returns true when status is PENDING and startTime <= now', () => {
        const now = new Date('2026-11-12T10:00:00.000Z');
        const startTime = new Date('2026-11-12T09:59:00.000Z');
        expect(shouldStartAuction('PENDING', startTime, now)).toBe(true);
      });

      it('returns false when startTime > now', () => {
        const now = new Date('2026-11-12T10:00:00.000Z');
        const futureStart = new Date('2026-11-12T10:05:00.000Z');
        expect(shouldStartAuction('PENDING', futureStart, now)).toBe(false);
      });

      it('returns false when status is not PENDING', () => {
        const now = new Date('2026-11-12T10:00:00.000Z');
        const pastStart = new Date('2026-11-12T09:00:00.000Z');
        expect(shouldStartAuction('INITIALIZING', pastStart, now)).toBe(false);
        expect(shouldStartAuction('ACTIVE', pastStart, now)).toBe(false);
        expect(shouldStartAuction('ENDED', pastStart, now)).toBe(false);
        expect(shouldStartAuction('CANCELLED', pastStart, now)).toBe(false);
      });
    });

    describe('shouldEndAuction', () => {
      it('returns true when status is ACTIVE and endTime <= now', () => {
        const now = new Date('2026-11-12T12:00:00.000Z');
        const endTime = new Date('2026-11-12T11:59:00.000Z');
        expect(shouldEndAuction('ACTIVE', endTime, now)).toBe(true);
      });

      it('returns false when endTime > now', () => {
        const now = new Date('2026-11-12T12:00:00.000Z');
        const futureEnd = new Date('2026-11-12T12:30:00.000Z');
        expect(shouldEndAuction('ACTIVE', futureEnd, now)).toBe(false);
      });

      it('returns false when status is not ACTIVE', () => {
        const now = new Date('2026-11-12T12:00:00.000Z');
        const pastEnd = new Date('2026-11-12T11:00:00.000Z');
        expect(shouldEndAuction('PENDING', pastEnd, now)).toBe(false);
        expect(shouldEndAuction('INITIALIZING', pastEnd, now)).toBe(false);
        expect(shouldEndAuction('ENDED', pastEnd, now)).toBe(false);
      });
    });

    describe('computeAuctionEndResult (Winner vs No-bid)', () => {
      it('determines winnerId and finalPrice when bids were placed', () => {
        const result = computeAuctionEndResult({
          leadingBidderId: '10000000-0000-4000-8000-000000000003',
          currentPrice: '250000',
        });

        expect(result).toEqual({
          winnerId: '10000000-0000-4000-8000-000000000003',
          finalPrice: '250000',
        });
      });

      it('sets winnerId and finalPrice to null when no bids were placed', () => {
        const result = computeAuctionEndResult({
          leadingBidderId: null,
          currentPrice: '100000',
        });

        expect(result).toEqual({
          winnerId: null,
          finalPrice: null,
        });
      });

      it('handles empty string leadingBidderId as no-bid', () => {
        const result = computeAuctionEndResult({
          leadingBidderId: '   ',
          currentPrice: '100000',
        });

        expect(result).toEqual({
          winnerId: null,
          finalPrice: null,
        });
      });
    });
  });

  describe('AuctionLifecycleScheduler', () => {
    let scheduler: AuctionLifecycleScheduler;
    let mockDb: {
      query: ReturnType<typeof vi.fn>;
      execute: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    };
    let mockRealtime: {
      publishAuctionStatus: ReturnType<typeof vi.fn>;
    };

    const samplePendingAuction = {
      id: '20000000-0000-4000-8000-000000000001',
      productId: '30000000-0000-4000-8000-000000000001',
      sellerId: '10000000-0000-4000-8000-000000000002',
      startTime: new Date('2026-11-12T09:00:00.000Z'),
      endTime: new Date('2026-11-12T11:00:00.000Z'),
      version: 0,
    };

    const sampleActiveAuctionWithWinner = {
      id: '20000000-0000-4000-8000-000000000002',
      productId: '30000000-0000-4000-8000-000000000002',
      sellerId: '10000000-0000-4000-8000-000000000002',
      productTitle: 'Vintage Watch',
      productThumbnail: 'https://example.com/watch.jpg',
      currentPrice: '300000',
      leadingBidderId: '10000000-0000-4000-8000-000000000003',
      currency: 'VND',
      version: 5,
    };

    const sampleActiveAuctionNoBid = {
      id: '20000000-0000-4000-8000-000000000003',
      productId: '30000000-0000-4000-8000-000000000003',
      sellerId: '10000000-0000-4000-8000-000000000002',
      productTitle: 'Antiques',
      productThumbnail: null,
      currentPrice: '100000',
      leadingBidderId: null,
      currency: 'VND',
      version: 1,
    };

    beforeEach(() => {
      mockDb = {
        query: vi.fn(),
        execute: vi.fn(),
        transaction: vi.fn(),
      };
      mockRealtime = {
        publishAuctionStatus: vi.fn(),
      };

      scheduler = new AuctionLifecycleScheduler(
        mockDb as unknown as Database,
        mockRealtime as unknown as Realtime,
      );
    });

    describe('startPendingAuctions', () => {
      it('starts pending auction, updates status=ACTIVE, increments version and enqueues auction.started', async () => {
        const executeSpy = vi.fn().mockResolvedValue(1);
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              query: vi.fn().mockResolvedValue([samplePendingAuction]),
              execute: executeSpy,
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        const count = await scheduler.startPendingAuctions();

        expect(count).toBe(1);

        // Verify UPDATE status = 'ACTIVE' and version = 1
        expect(executeSpy).toHaveBeenCalledWith(
          expect.stringContaining("SET status = 'ACTIVE'"),
          1, // newVersion
          samplePendingAuction.id,
        );

        // Verify OutboxEvent insert with auction.started
        expect(executeSpy).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO "OutboxEvent"'),
          expect.any(String), // eventId
          samplePendingAuction.id, // aggregateId
          1, // aggregateVersion
          'auction_exchange',
          'auction.started',
          expect.stringContaining('"eventName":"auction.started"'),
        );

        // Verify Realtime socket emit called post-commit
        expect(mockRealtime.publishAuctionStatus).toHaveBeenCalledWith(
          samplePendingAuction.id,
          expect.objectContaining({
            auctionId: samplePendingAuction.id,
            productId: samplePendingAuction.productId,
            status: 'ACTIVE',
            version: 1,
          }),
        );
      });

      it('does not fail if socket emission fails (only logs warning)', async () => {
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              query: vi.fn().mockResolvedValue([samplePendingAuction]),
              execute: vi.fn().mockResolvedValue(1),
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        mockRealtime.publishAuctionStatus.mockImplementation(() => {
          throw new Error('Socket adapter unreachable');
        });

        await expect(scheduler.startPendingAuctions()).resolves.toBe(1);
      });
    });

    describe('endActiveAuctions', () => {
      it('ends active auction with winner, enqueues auction.ended and emits socket', async () => {
        const executeSpy = vi.fn().mockResolvedValue(1);
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              query: vi.fn().mockResolvedValue([sampleActiveAuctionWithWinner]),
              execute: executeSpy,
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        const count = await scheduler.endActiveAuctions();

        expect(count).toBe(1);

        // Verify UPDATE status = 'ENDED' with winnerId, finalPrice, version = 6
        expect(executeSpy).toHaveBeenCalledWith(
          expect.stringContaining("SET status = 'ENDED'"),
          '10000000-0000-4000-8000-000000000003', // winnerId
          '300000', // finalPrice
          6, // newVersion (5 + 1)
          sampleActiveAuctionWithWinner.id,
        );

        // Verify OutboxEvent insert with auction.ended
        expect(executeSpy).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO "OutboxEvent"'),
          expect.any(String), // eventId
          sampleActiveAuctionWithWinner.id, // aggregateId
          6, // aggregateVersion
          'auction_exchange',
          'auction.ended',
          expect.stringContaining('"eventName":"auction.ended"'),
        );

        // Verify Realtime socket emit called post-commit
        expect(mockRealtime.publishAuctionStatus).toHaveBeenCalledWith(
          sampleActiveAuctionWithWinner.id,
          expect.objectContaining({
            auctionId: sampleActiveAuctionWithWinner.id,
            winnerId: '10000000-0000-4000-8000-000000000003',
            finalPrice: '300000',
            status: 'ENDED',
            version: 6,
          }),
        );
      });

      it('ends active auction without bids, setting winnerId and finalPrice to null', async () => {
        const executeSpy = vi.fn().mockResolvedValue(1);
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              query: vi.fn().mockResolvedValue([sampleActiveAuctionNoBid]),
              execute: executeSpy,
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        const count = await scheduler.endActiveAuctions();

        expect(count).toBe(1);

        // Verify UPDATE status = 'ENDED' with null winnerId and null finalPrice
        expect(executeSpy).toHaveBeenCalledWith(
          expect.stringContaining("SET status = 'ENDED'"),
          null, // winnerId
          null, // finalPrice
          2, // newVersion (1 + 1)
          sampleActiveAuctionNoBid.id,
        );

        // Verify OutboxEvent payload has null winnerId and finalPrice
        expect(executeSpy).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO "OutboxEvent"'),
          expect.any(String),
          sampleActiveAuctionNoBid.id,
          2,
          'auction_exchange',
          'auction.ended',
          expect.stringContaining('"winnerId":null'),
        );

        expect(mockRealtime.publishAuctionStatus).toHaveBeenCalledWith(
          sampleActiveAuctionNoBid.id,
          expect.objectContaining({
            winnerId: null,
            finalPrice: null,
            status: 'ENDED',
            version: 2,
          }),
        );
      });
    });

    describe('start and stop controls', () => {
      it('starts timer with unref and stops cleanly', () => {
        scheduler.start(5000);
        scheduler.stop();
      });
    });
  });
});
