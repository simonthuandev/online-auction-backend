import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuctionCreateService,
  type CreateAuctionInput,
} from './auction-create.service.js';
import {
  AuctionReservationWorker,
  type InitializingAuctionRecord,
} from './auction-reservation.worker.js';
import { ServiceHandlers } from '../../service-handlers.js';
import {
  HttpHandlers,
  EventHandlers,
  InternalResponseError,
  type Database,
  type Transaction,
  type InternalHttp,
} from '../../../../../libs/common/src/index.js';
import type { AuctionQueryService } from '../query/auction-query.service.js';

describe('AuctionCreateService & ReservationWorker (Unit Tests)', () => {
  let createService: AuctionCreateService;
  let reservationWorker: AuctionReservationWorker;
  let mockDb: {
    query: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  let mockInternalHttp: {
    reserveProduct: ReturnType<typeof vi.fn>;
  };

  const sellerId = '10000000-0000-4000-8000-000000000002';
  const idempotencyKey = 'idemp-key-12345678';

  const validBody: CreateAuctionInput = {
    productId: '30000000-0000-4000-8000-000000000001',
    startingPrice: '100000',
    bidIncrement: '10000',
    startTime: new Date(Date.now() + 60000).toISOString(),
    endTime: new Date(Date.now() + 120000).toISOString(),
  };

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
    };

    mockInternalHttp = {
      reserveProduct: vi.fn(),
    };

    createService = new AuctionCreateService(mockDb as unknown as Database);
    reservationWorker = new AuctionReservationWorker(
      mockDb as unknown as Database,
      mockInternalHttp as unknown as InternalHttp,
    );
  });

  describe('AuctionCreateService - Input Validation', () => {
    it('throws UnauthorizedException if sellerId is missing', async () => {
      await expect(
        createService.createAuction('', idempotencyKey, validBody),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws BadRequestException if Idempotency-Key header is missing', async () => {
      await expect(
        createService.createAuction(sellerId, '', validBody),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if productId is not a valid UUID', async () => {
      await expect(
        createService.createAuction(sellerId, idempotencyKey, {
          ...validBody,
          productId: 'invalid-uuid',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if startingPrice is 0 or negative (Decision #6)', async () => {
      await expect(
        createService.createAuction(sellerId, idempotencyKey, {
          ...validBody,
          startingPrice: '0',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        createService.createAuction(sellerId, idempotencyKey, {
          ...validBody,
          startingPrice: '-5000',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if bidIncrement is 0 or negative (Decision #6)', async () => {
      await expect(
        createService.createAuction(sellerId, idempotencyKey, {
          ...validBody,
          bidIncrement: '0',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        createService.createAuction(sellerId, idempotencyKey, {
          ...validBody,
          bidIncrement: 'abc',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if startTime < now - 5s (Decision #3)', async () => {
      const pastStartTime = new Date(Date.now() - 10000).toISOString();
      await expect(
        createService.createAuction(sellerId, idempotencyKey, {
          ...validBody,
          startTime: pastStartTime,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if endTime <= startTime (Decision #3)', async () => {
      const now = new Date(Date.now() + 60000).toISOString();
      await expect(
        createService.createAuction(sellerId, idempotencyKey, {
          ...validBody,
          startTime: now,
          endTime: now,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('AuctionCreateService - Creation & Idempotency', () => {
    it('successfully inserts Auction INITIALIZING and returns 202 response', async () => {
      let capturedHash = '';
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            execute: vi.fn().mockImplementation((sql: string, ...args: unknown[]) => {
              if (sql.includes('INSERT INTO "IdempotencyRecord"')) {
                capturedHash = String(args[4]);
              }
              return Promise.resolve(1);
            }),
            query: vi.fn().mockImplementation((sql: string) => {
              if (sql.includes('SELECT "requestHash"')) {
                return Promise.resolve([
                  {
                    requestHash: capturedHash,
                    response: null,
                    statusCode: null,
                  },
                ]);
              }
              if (sql.includes("SELECT timezone('UTC', now())")) {
                return Promise.resolve([{ dbNow: new Date() }]);
              }
              if (sql.includes('INSERT INTO "Auction"')) {
                return Promise.resolve([
                  {
                    id: '20000000-0000-4000-8000-000000000001',
                    productId: validBody.productId,
                    sellerId,
                    productTitle: null,
                    productThumbnail: null,
                    startingPrice: validBody.startingPrice,
                    currentPrice: validBody.startingPrice,
                    bidIncrement: validBody.bidIncrement,
                    currency: 'VND',
                    startTime: validBody.startTime,
                    endTime: validBody.endTime,
                    status: 'INITIALIZING',
                    version: 0,
                    winnerId: null,
                    finalPrice: null,
                  },
                ]);
              }
              return Promise.resolve([]);
            }),
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      const result = await createService.createAuction(
        sellerId,
        idempotencyKey,
        validBody,
      );

      expect(result).toBeDefined();
      expect(result.id).toBe('20000000-0000-4000-8000-000000000001');
      expect(result.status).toBe('INITIALIZING');
      expect(result.currentPrice).toBe(validBody.startingPrice);
      expect(result.startingPrice).toBe(validBody.startingPrice);
      expect(result.bidIncrement).toBe(validBody.bidIncrement);
      expect(result.version).toBe(0);
      expect(result.productTitle).toBeNull();
      expect(result.winnerId).toBeNull();
    });

    it('throws ConflictException (409) if product already has open auction (23505 / P2002)', async () => {
      let capturedHash = '';
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            execute: vi.fn().mockImplementation((sql: string, ...args: unknown[]) => {
              if (sql.includes('INSERT INTO "IdempotencyRecord"')) {
                capturedHash = String(args[4]);
              }
              return Promise.resolve(1);
            }),
            query: vi.fn().mockImplementation((sql: string) => {
              if (sql.includes('SELECT "requestHash"')) {
                return Promise.resolve([
                  { requestHash: capturedHash, response: null, statusCode: null },
                ]);
              }
              if (sql.includes("SELECT timezone('UTC', now())")) {
                return Promise.resolve([{ dbNow: new Date() }]);
              }
              if (sql.includes('INSERT INTO "Auction"')) {
                const error = new Error('Unique constraint violation') as Error & {
                  code: string;
                };
                error.code = '23505';
                return Promise.reject(error);
              }
              return Promise.resolve([]);
            }),
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      await expect(
        createService.createAuction(sellerId, idempotencyKey, validBody),
      ).rejects.toThrow(ConflictException);
    });

    it('returns cached response on idempotent replay with same key and body', async () => {
      const cachedResponse = {
        id: '20000000-0000-4000-8000-000000000001',
        productId: validBody.productId,
        sellerId,
        productTitle: null,
        productThumbnail: null,
        startingPrice: '100000',
        currentPrice: '100000',
        bidIncrement: '10000',
        currency: 'VND',
        startTime: validBody.startTime,
        endTime: validBody.endTime,
        status: 'INITIALIZING',
        version: 0,
        winnerId: null,
        finalPrice: null,
      };

      let capturedHash = '';
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            execute: vi.fn().mockImplementation((sql: string, ...args: unknown[]) => {
              if (sql.includes('INSERT INTO "IdempotencyRecord"')) {
                capturedHash = String(args[4]);
              }
              return Promise.resolve(1);
            }),
            query: vi.fn().mockImplementation((sql: string) => {
              if (sql.includes('SELECT "requestHash"')) {
                return Promise.resolve([
                  {
                    requestHash: capturedHash,
                    response: cachedResponse,
                    statusCode: 202,
                  },
                ]);
              }
              return Promise.resolve([]);
            }),
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      const result = await createService.createAuction(
        sellerId,
        idempotencyKey,
        validBody,
      );

      expect(result).toEqual(cachedResponse);
    });
  });

  describe('AuctionReservationWorker - Error Classification & Recovery', () => {
    const mockAuctionRecord: InitializingAuctionRecord = {
      id: '20000000-0000-4000-8000-000000000001',
      productId: '30000000-0000-4000-8000-000000000001',
      sellerId: '10000000-0000-4000-8000-000000000002',
      createdAt: new Date(),
    };

    it('transitions INITIALIZING -> PENDING on successful reservation and stores title/thumbnail', async () => {
      mockInternalHttp.reserveProduct.mockResolvedValue({
        auctionId: mockAuctionRecord.id,
        productId: mockAuctionRecord.productId,
        sellerId: mockAuctionRecord.sellerId,
        productTitle: 'Vintage Mechanical Watch',
        productThumbnail: 'https://example.com/thumb.jpg',
      });

      const executeSpy = vi.fn().mockResolvedValue(1);
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            query: vi.fn().mockResolvedValue([
              { id: mockAuctionRecord.id, status: 'INITIALIZING' },
            ]),
            execute: executeSpy,
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      await reservationWorker.processAuction(mockAuctionRecord);

      expect(mockInternalHttp.reserveProduct).toHaveBeenCalledWith(
        mockAuctionRecord.productId,
        {
          auctionId: mockAuctionRecord.id,
          sellerId: mockAuctionRecord.sellerId,
        },
        mockAuctionRecord.id,
      );

      expect(executeSpy).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'PENDING'"),
        'Vintage Mechanical Watch',
        'https://example.com/thumb.jpg',
        mockAuctionRecord.id,
      );
    });

    it('transitions INITIALIZING -> CANCELLED on 403 InternalResponseError (Decision #9)', async () => {
      mockInternalHttp.reserveProduct.mockRejectedValue(
        new InternalResponseError(403, 'Seller mismatch'),
      );

      const executeSpy = vi.fn().mockResolvedValue(1);
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            query: vi.fn().mockResolvedValue([
              { id: mockAuctionRecord.id, status: 'INITIALIZING' },
            ]),
            execute: executeSpy,
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      await reservationWorker.processAuction(mockAuctionRecord);

      expect(executeSpy).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'CANCELLED'"),
        'Seller mismatch',
        mockAuctionRecord.id,
      );
    });

    it('transitions INITIALIZING -> CANCELLED on 404 InternalResponseError (Decision #9)', async () => {
      mockInternalHttp.reserveProduct.mockRejectedValue(
        new InternalResponseError(404, 'Product not found'),
      );

      const executeSpy = vi.fn().mockResolvedValue(1);
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            query: vi.fn().mockResolvedValue([
              { id: mockAuctionRecord.id, status: 'INITIALIZING' },
            ]),
            execute: executeSpy,
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      await reservationWorker.processAuction(mockAuctionRecord);

      expect(executeSpy).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'CANCELLED'"),
        'Product not found',
        mockAuctionRecord.id,
      );
    });

    it('transitions INITIALIZING -> CANCELLED on 409 InternalResponseError (Decision #9)', async () => {
      mockInternalHttp.reserveProduct.mockRejectedValue(
        new InternalResponseError(409, 'Product not in READY status'),
      );

      const executeSpy = vi.fn().mockResolvedValue(1);
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            query: vi.fn().mockResolvedValue([
              { id: mockAuctionRecord.id, status: 'INITIALIZING' },
            ]),
            execute: executeSpy,
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      await reservationWorker.processAuction(mockAuctionRecord);

      expect(executeSpy).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'CANCELLED'"),
        'Product not in READY status',
        mockAuctionRecord.id,
      );
    });

    it('keeps INITIALIZING on 5xx InternalResponseError to allow retry (Decision #9)', async () => {
      mockInternalHttp.reserveProduct.mockRejectedValue(
        new InternalResponseError(500, 'Internal Server Error'),
      );

      await reservationWorker.processAuction(mockAuctionRecord);

      // Should NOT open transaction to cancel or update
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('keeps INITIALIZING on network Error to allow retry (Decision #9)', async () => {
      mockInternalHttp.reserveProduct.mockRejectedValue(
        new Error('ECONNREFUSED or network timeout'),
      );

      await reservationWorker.processAuction(mockAuctionRecord);

      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('marks CANCELLED if auction was created > 10 minutes ago (Decision #9)', async () => {
      const expiredAuction: InitializingAuctionRecord = {
        ...mockAuctionRecord,
        createdAt: new Date(Date.now() - 11 * 60 * 1000), // 11 mins ago
      };

      const executeSpy = vi.fn().mockResolvedValue(1);
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            query: vi.fn().mockResolvedValue([
              { id: expiredAuction.id, status: 'INITIALIZING' },
            ]),
            execute: executeSpy,
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      await reservationWorker.processAuction(expiredAuction);

      // reserveProduct should NOT be called because it timed out
      expect(mockInternalHttp.reserveProduct).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalledWith(
        expect.stringContaining("SET status = 'CANCELLED'"),
        'Reservation timed out after 10 minutes',
        expiredAuction.id,
      );
    });

    it('does not overwrite if auction status is no longer INITIALIZING when locking', async () => {
      mockInternalHttp.reserveProduct.mockResolvedValue({
        auctionId: mockAuctionRecord.id,
        productId: mockAuctionRecord.productId,
        sellerId: mockAuctionRecord.sellerId,
        productTitle: 'Vintage Watch',
        productThumbnail: null,
      });

      const executeSpy = vi.fn().mockResolvedValue(1);
      mockDb.transaction.mockImplementation(
        async (fn: (tx: Transaction) => Promise<unknown>) => {
          const fakeTx = {
            // Already updated to PENDING by another worker
            query: vi.fn().mockResolvedValue([
              { id: mockAuctionRecord.id, status: 'PENDING' },
            ]),
            execute: executeSpy,
          };
          return fn(fakeTx as unknown as Transaction);
        },
      );

      await reservationWorker.processAuction(mockAuctionRecord);

      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe('ServiceHandlers integration', () => {
    let handlers: ServiceHandlers;
    let mockHttp: { register: ReturnType<typeof vi.fn> };
    let mockEvents: { register: ReturnType<typeof vi.fn> };
    const registeredHandlers = new Map<
      string,
      (req: unknown) => Promise<unknown>
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
      handlers = new ServiceHandlers(
        mockHttp as unknown as HttpHandlers,
        mockEvents as unknown as EventHandlers,
        {} as AuctionQueryService,
        createService,
      );
      handlers.onModuleInit();
    });

    it('registers auction_post__api_auctions', () => {
      expect(registeredHandlers.has('auction_post__api_auctions')).toBe(true);
    });

    it('delegates auction_post__api_auctions to createService with sellerId and Idempotency-Key', async () => {
      const createSpy = vi.spyOn(createService, 'createAuction').mockResolvedValue({
        id: 'auction-123',
        productId: validBody.productId,
        sellerId,
        productTitle: null,
        productThumbnail: null,
        startingPrice: '100000',
        currentPrice: '100000',
        bidIncrement: '10000',
        currency: 'VND',
        startTime: validBody.startTime,
        endTime: validBody.endTime,
        status: 'INITIALIZING',
        version: 0,
        winnerId: null,
        finalPrice: null,
      });

      const handler = registeredHandlers.get('auction_post__api_auctions')!;
      const result = await handler({
        principal: { sub: sellerId, role: 'SELLER' },
        headers: { 'idempotency-key': idempotencyKey },
        body: validBody,
      });

      expect(createSpy).toHaveBeenCalledWith(
        sellerId,
        idempotencyKey,
        validBody,
      );
      expect((result as { id: string }).id).toBe('auction-123');
    });

    it('throws UnauthorizedException if principal is missing in handler', async () => {
      const handler = registeredHandlers.get('auction_post__api_auctions')!;
      await expect(
        handler({
          principal: undefined,
          headers: { 'idempotency-key': idempotencyKey },
          body: validBody,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
