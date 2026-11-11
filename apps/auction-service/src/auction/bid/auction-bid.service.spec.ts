import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { validateBidRules, type BidValidationInput } from './auction-bid.domain.js';
import { AuctionBidService, type PlaceBidInput } from './auction-bid.service.js';
import { ServiceHandlers } from '../../service-handlers.js';
import {
  HttpHandlers,
  EventHandlers,
  type Database,
  type Transaction,
  type Realtime,
  type AuthRequest,
} from '../../../../../libs/common/src/index.js';
import type { AuctionQueryService } from '../query/auction-query.service.js';
import type { AuctionCreateService } from '../create/auction-create.service.js';

describe('Auction Bid (Unit Tests)', () => {
  describe('Pure Domain Function: validateBidRules (Decision #4)', () => {
    const baseInput: BidValidationInput = {
      bidderId: '10000000-0000-4000-8000-000000000003',
      sellerId: '10000000-0000-4000-8000-000000000002',
      status: 'ACTIVE',
      startTime: '2026-11-10T10:00:00.000Z',
      endTime: '2026-11-12T10:00:00.000Z',
      now: '2026-11-11T10:00:00.000Z',
      startingPrice: '100000',
      currentPrice: '100000',
      bidIncrement: '10000',
      leadingBidderId: null,
      amount: '100000',
    };

    it('passes for a valid first bid matching startingPrice', () => {
      expect(() => validateBidRules(baseInput)).not.toThrow();
    });

    it('passes for a valid first bid exceeding startingPrice', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          amount: '120000',
        }),
      ).not.toThrow();
    });

    it('throws BadRequestException for first bid below startingPrice', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          amount: '99999',
        }),
      ).toThrow(BadRequestException);
    });

    it('passes for a valid subsequent bid matching currentPrice + bidIncrement', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          currentPrice: '150000',
          leadingBidderId: '10000000-0000-4000-8000-000000000099',
          amount: '160000',
        }),
      ).not.toThrow();
    });

    it('passes for a valid subsequent bid exceeding currentPrice + bidIncrement', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          currentPrice: '150000',
          leadingBidderId: '10000000-0000-4000-8000-000000000099',
          amount: '200000',
        }),
      ).not.toThrow();
    });

    it('throws BadRequestException for subsequent bid below currentPrice + bidIncrement', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          currentPrice: '150000',
          leadingBidderId: '10000000-0000-4000-8000-000000000099',
          amount: '159999',
        }),
      ).toThrow(BadRequestException);
    });

    it('throws ConflictException if auction status is not ACTIVE', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          status: 'PENDING',
        }),
      ).toThrow(ConflictException);

      expect(() =>
        validateBidRules({
          ...baseInput,
          status: 'INITIALIZING',
        }),
      ).toThrow(ConflictException);

      expect(() =>
        validateBidRules({
          ...baseInput,
          status: 'ENDED',
        }),
      ).toThrow(ConflictException);

      expect(() =>
        validateBidRules({
          ...baseInput,
          status: 'CANCELLED',
        }),
      ).toThrow(ConflictException);
    });

    it('throws ConflictException if auction has already ended (now >= endTime)', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          now: '2026-11-12T10:00:00.000Z',
          endTime: '2026-11-12T10:00:00.000Z',
        }),
      ).toThrow(ConflictException);

      expect(() =>
        validateBidRules({
          ...baseInput,
          now: '2026-11-12T10:00:01.000Z',
          endTime: '2026-11-12T10:00:00.000Z',
        }),
      ).toThrow(ConflictException);
    });

    it('throws ForbiddenException if bidder is the seller', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          bidderId: baseInput.sellerId,
        }),
      ).toThrow(ForbiddenException);
    });

    it('throws ConflictException if bidder is already the leading bidder', () => {
      expect(() =>
        validateBidRules({
          ...baseInput,
          leadingBidderId: baseInput.bidderId,
          amount: '200000',
        }),
      ).toThrow(ConflictException);
    });
  });

  describe('AuctionBidService', () => {
    let bidService: AuctionBidService;
    let mockDb: {
      query: ReturnType<typeof vi.fn>;
      execute: ReturnType<typeof vi.fn>;
      transaction: ReturnType<typeof vi.fn>;
    };
    let mockRealtime: {
      publishBidUpdate: ReturnType<typeof vi.fn>;
    };

    const bidderId = '10000000-0000-4000-8000-000000000003';
    const sellerId = '10000000-0000-4000-8000-000000000002';
    const auctionId = '20000000-0000-4000-8000-000000000001';
    const idempotencyKey = 'idemp-key-12345678';
    const validBody: PlaceBidInput = {
      amount: '150000',
    };

    const lockedAuctionRow = {
      id: auctionId,
      productId: '30000000-0000-4000-8000-000000000001',
      sellerId,
      productTitle: 'Vintage Watch',
      startingPrice: '100000',
      currentPrice: '100000',
      bidIncrement: '10000',
      currency: 'VND',
      startTime: new Date('2026-11-10T10:00:00.000Z'),
      endTime: new Date('2026-11-15T10:00:00.000Z'),
      status: 'ACTIVE',
      leadingBidderId: null,
      version: 1,
      dbNow: new Date('2026-11-11T10:00:00.000Z'),
    };

    const insertedBidRow = {
      id: '40000000-0000-4000-8000-000000000001',
      auctionId,
      bidderId,
      amount: '150000',
      createdAt: new Date('2026-11-11T10:00:00.000Z'),
    };

    beforeEach(() => {
      mockDb = {
        query: vi.fn(),
        execute: vi.fn(),
        transaction: vi.fn(),
      };

      mockRealtime = {
        publishBidUpdate: vi.fn(),
      };

      bidService = new AuctionBidService(
        mockDb as unknown as Database,
        mockRealtime as unknown as Realtime,
      );
    });

    describe('Input Validation', () => {
      it('throws UnauthorizedException if bidderId is empty', async () => {
        await expect(
          bidService.placeBid('', auctionId, idempotencyKey, validBody),
        ).rejects.toThrow(UnauthorizedException);
      });

      it('throws BadRequestException if Idempotency-Key is missing or empty', async () => {
        await expect(
          bidService.placeBid(bidderId, auctionId, '', validBody),
        ).rejects.toThrow(BadRequestException);
      });

      it('throws BadRequestException if auctionId is not a valid UUID', async () => {
        await expect(
          bidService.placeBid(bidderId, 'not-a-uuid', idempotencyKey, validBody),
        ).rejects.toThrow(BadRequestException);
      });

      it('throws BadRequestException if body is invalid', async () => {
        await expect(
          bidService.placeBid(
            bidderId,
            auctionId,
            idempotencyKey,
            null as unknown as PlaceBidInput,
          ),
        ).rejects.toThrow(BadRequestException);
      });

      it('throws BadRequestException if amount is missing, non-numeric, or <= 0', async () => {
        await expect(
          bidService.placeBid(bidderId, auctionId, idempotencyKey, {
            amount: '',
          }),
        ).rejects.toThrow(BadRequestException);

        await expect(
          bidService.placeBid(bidderId, auctionId, idempotencyKey, {
            amount: 'abc',
          }),
        ).rejects.toThrow(BadRequestException);

        await expect(
          bidService.placeBid(bidderId, auctionId, idempotencyKey, {
            amount: '0',
          }),
        ).rejects.toThrow(BadRequestException);

        await expect(
          bidService.placeBid(bidderId, auctionId, idempotencyKey, {
            amount: '-50000',
          }),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('Execution Flow and Idempotency', () => {
      it('successfully places a bid, updates auction, enqueues event, and publishes socket', async () => {
        let capturedHash = '';
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              execute: vi.fn((sql: string, ...args: unknown[]) => {
                if (sql.includes('INSERT INTO "IdempotencyRecord"')) {
                  capturedHash = String(args[4]);
                }
                return Promise.resolve(1);
              }),
              query: vi.fn((sql: string) => {
                if (sql.includes('SELECT "requestHash"')) {
                  return Promise.resolve([
                    {
                      requestHash: capturedHash,
                      response: null,
                      statusCode: null,
                    },
                  ]);
                }
                if (sql.includes('FROM "Auction"')) {
                  return Promise.resolve([lockedAuctionRow]);
                }
                if (sql.includes('INSERT INTO "Bid"')) {
                  return Promise.resolve([insertedBidRow]);
                }
                return Promise.resolve([]);
              }),
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        const result = await bidService.placeBid(
          bidderId,
          auctionId,
          idempotencyKey,
          validBody,
        );

        expect(result).toEqual({
          id: insertedBidRow.id,
          auctionId: insertedBidRow.auctionId,
          bidderId: insertedBidRow.bidderId,
          amount: '150000',
          createdAt: '2026-11-11T10:00:00.000Z',
        });

        // Socket must be published with version 2 (lockedAuctionRow.version + 1)
        expect(mockRealtime.publishBidUpdate).toHaveBeenCalledTimes(1);
        expect(mockRealtime.publishBidUpdate).toHaveBeenCalledWith(
          auctionId,
          expect.objectContaining({
            auctionId,
            productId: lockedAuctionRow.productId,
            newBidderId: bidderId,
            previousBidderId: null,
            currentPrice: '150000',
            version: 2,
          }),
        );
      });

      it('replays response from IdempotencyRecord without emitting socket a second time', async () => {
        const cachedResponse = {
          id: '40000000-0000-4000-8000-000000000001',
          auctionId,
          bidderId,
          amount: '150000',
          createdAt: '2026-11-11T10:00:00.000Z',
        };

        let capturedHash = '';
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              execute: vi.fn((sql: string, ...args: unknown[]) => {
                if (sql.includes('INSERT INTO "IdempotencyRecord"')) {
                  capturedHash = String(args[4]);
                }
                return Promise.resolve(1);
              }),
              query: vi.fn((sql: string) => {
                if (sql.includes('SELECT "requestHash"')) {
                  return Promise.resolve([
                    {
                      requestHash: capturedHash,
                      statusCode: 201,
                      response: cachedResponse,
                    },
                  ]);
                }
                return Promise.resolve([]);
              }),
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        const result = await bidService.placeBid(
          bidderId,
          auctionId,
          idempotencyKey,
          validBody,
        );

        expect(result).toEqual(cachedResponse);
        // Socket should NOT be published on idempotent replay
        expect(mockRealtime.publishBidUpdate).not.toHaveBeenCalled();
      });

      it('throws NotFoundException if auction does not exist in DB', async () => {
        let capturedHash = '';
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              execute: vi.fn((sql: string, ...args: unknown[]) => {
                if (sql.includes('INSERT INTO "IdempotencyRecord"')) {
                  capturedHash = String(args[4]);
                }
                return Promise.resolve(1);
              }),
              query: vi.fn((sql: string) => {
                if (sql.includes('SELECT "requestHash"')) {
                  return Promise.resolve([
                    {
                      requestHash: capturedHash,
                      response: null,
                      statusCode: null,
                    },
                  ]);
                }
                if (sql.includes('FROM "Auction"')) {
                  return Promise.resolve([]);
                }
                return Promise.resolve([]);
              }),
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        await expect(
          bidService.placeBid(bidderId, auctionId, idempotencyKey, validBody),
        ).rejects.toThrow(NotFoundException);

        expect(mockRealtime.publishBidUpdate).not.toHaveBeenCalled();
      });

      it('handles socket error gracefully without throwing', async () => {
        let capturedHash = '';
        mockDb.transaction.mockImplementation(
          async (fn: (tx: Transaction) => Promise<unknown>) => {
            const fakeTx = {
              execute: vi.fn((sql: string, ...args: unknown[]) => {
                if (sql.includes('INSERT INTO "IdempotencyRecord"')) {
                  capturedHash = String(args[4]);
                }
                return Promise.resolve(1);
              }),
              query: vi.fn((sql: string) => {
                if (sql.includes('SELECT "requestHash"')) {
                  return Promise.resolve([
                    {
                      requestHash: capturedHash,
                      response: null,
                      statusCode: null,
                    },
                  ]);
                }
                if (sql.includes('FROM "Auction"')) {
                  return Promise.resolve([lockedAuctionRow]);
                }
                if (sql.includes('INSERT INTO "Bid"')) {
                  return Promise.resolve([insertedBidRow]);
                }
                return Promise.resolve([]);
              }),
            };
            return fn(fakeTx as unknown as Transaction);
          },
        );

        mockRealtime.publishBidUpdate.mockImplementation(() => {
          throw new Error('Redis connection lost');
        });

        const result = await bidService.placeBid(
          bidderId,
          auctionId,
          idempotencyKey,
          validBody,
        );

        expect(result).toBeDefined();
        expect(result.id).toBe(insertedBidRow.id);
      });
    });
  });

  describe('ServiceHandlers integration', () => {
    let handlers: ServiceHandlers;
    let mockHttp: { register: ReturnType<typeof vi.fn> };
    let mockEvents: { register: ReturnType<typeof vi.fn> };
    let mockBidService: { placeBid: ReturnType<typeof vi.fn> };
    const registeredHandlers = new Map<
      string,
      (req: AuthRequest) => Promise<unknown>
    >();

    beforeEach(() => {
      registeredHandlers.clear();
      mockHttp = {
        register: vi.fn((opId, fn) => {
          registeredHandlers.set(opId, fn);
        }),
      };
      mockEvents = {
        register: vi.fn(),
      };
      mockBidService = {
        placeBid: vi.fn(),
      };

      handlers = new ServiceHandlers(
        mockHttp as unknown as HttpHandlers,
        mockEvents as unknown as EventHandlers,
        {} as AuctionQueryService,
        {} as AuctionCreateService,
        mockBidService as unknown as AuctionBidService,
      );
      handlers.onModuleInit();
    });

    it('registers auction_post__api_auctions_id_bids', () => {
      expect(registeredHandlers.has('auction_post__api_auctions_id_bids')).toBe(
        true,
      );
    });

    it('delegates to auctionBid.placeBid with extracted parameters', async () => {
      const handler = registeredHandlers.get(
        'auction_post__api_auctions_id_bids',
      )!;

      mockBidService.placeBid.mockResolvedValue({
        id: 'bid-123',
        amount: '150000',
      });

      const req: AuthRequest = {
        principal: {
          sub: '10000000-0000-4000-8000-000000000003',
          role: 'USER',
        },
        params: { id: '20000000-0000-4000-8000-000000000001' },
        headers: {
          'idempotency-key': 'test-key-1234',
        },
        body: { amount: '150000' },
      } as unknown as AuthRequest;

      const res = await handler(req);
      expect(res).toEqual({ id: 'bid-123', amount: '150000' });
      expect(mockBidService.placeBid).toHaveBeenCalledWith(
        '10000000-0000-4000-8000-000000000003',
        '20000000-0000-4000-8000-000000000001',
        'test-key-1234',
        { amount: '150000' },
      );
    });

    it('throws UnauthorizedException if principal.sub is missing', async () => {
      const handler = registeredHandlers.get(
        'auction_post__api_auctions_id_bids',
      )!;

      const req: AuthRequest = {
        principal: undefined,
        params: { id: '20000000-0000-4000-8000-000000000001' },
        headers: { 'idempotency-key': 'test-key' },
        body: { amount: '150000' },
      } as unknown as AuthRequest;

      await expect(handler(req)).rejects.toThrow(UnauthorizedException);
    });
  });
});
