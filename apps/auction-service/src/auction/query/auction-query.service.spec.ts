import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AuctionQueryService,
  mapAuction,
  mapBid,
  formatDecimal,
  formatDate,
} from './auction-query.service.js';
import { ServiceHandlers } from '../../service-handlers.js';
import {
  HttpHandlers,
  EventHandlers,
} from '../../../../../libs/common/src/index.js';
import {
  AuctionStatus,
  type Auction,
  type Bid,
  Prisma,
} from '@prisma/client/auction/index.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

describe('AuctionQueryService (Unit Tests)', () => {
  let service: AuctionQueryService;
  let mockPrisma: {
    auction: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
    bid: {
      findMany: ReturnType<typeof vi.fn>;
      count: ReturnType<typeof vi.fn>;
    };
  };

  const sampleAuction: Auction = {
    id: '20000000-0000-4000-8000-000000000001',
    productId: '30000000-0000-4000-8000-000000000001',
    sellerId: '10000000-0000-4000-8000-000000000002',
    productTitle: 'Vintage Mechanical Watch',
    productThumbnail: 'https://example.com/watch.jpg',
    startingPrice: new Prisma.Decimal('100000'),
    currentPrice: new Prisma.Decimal('150000'),
    bidIncrement: new Prisma.Decimal('10000'),
    currency: 'VND',
    startTime: new Date('2026-11-10T10:00:00.000Z'),
    endTime: new Date('2026-11-12T10:00:00.000Z'),
    status: AuctionStatus.ACTIVE,
    leadingBidderId: '10000000-0000-4000-8000-000000000003',
    winnerId: null,
    finalPrice: null,
    version: 3,
    initializationRequest: { reason: 'test' },
    initializationError: null,
    createdAt: new Date('2026-11-10T09:00:00.000Z'),
    updatedAt: new Date('2026-11-10T11:00:00.000Z'),
  };

  const sampleInitializingAuction: Auction = {
    ...sampleAuction,
    id: '20000000-0000-4000-8000-000000000002',
    status: AuctionStatus.INITIALIZING,
    productTitle: null,
    productThumbnail: null,
    version: 0,
  };

  const sampleCancelledAuction: Auction = {
    ...sampleAuction,
    id: '20000000-0000-4000-8000-000000000003',
    status: AuctionStatus.CANCELLED,
    initializationError: 'Product reservation failed',
  };

  const sampleEndedAuction: Auction = {
    ...sampleAuction,
    id: '20000000-0000-4000-8000-000000000004',
    status: AuctionStatus.ENDED,
    winnerId: '10000000-0000-4000-8000-000000000003',
    finalPrice: new Prisma.Decimal('200000'),
  };

  const sampleBid: Bid = {
    id: '40000000-0000-4000-8000-000000000001',
    auctionId: sampleAuction.id,
    bidderId: '10000000-0000-4000-8000-000000000003',
    amount: new Prisma.Decimal('150000'),
    createdAt: new Date('2026-11-10T11:00:00.000Z'),
  };

  beforeEach(() => {
    mockPrisma = {
      auction: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        count: vi.fn(),
      },
      bid: {
        findMany: vi.fn(),
        count: vi.fn(),
      },
    };
    service = new AuctionQueryService(mockPrisma as unknown as PrismaService);
  });

  describe('Mapping functions', () => {
    it('formatDecimal formats Decimal to whole integer string', () => {
      expect(formatDecimal(new Prisma.Decimal('100000'))).toBe('100000');
      expect(formatDecimal(new Prisma.Decimal('100000.00'))).toBe('100000');
      expect(formatDecimal(150000)).toBe('150000');
      expect(formatDecimal('200000')).toBe('200000');
      expect(formatDecimal('200000.00')).toBe('200000');
    });

    it('formatDate formats Date to ISO UTC string', () => {
      const date = new Date('2026-11-11T12:34:56.789Z');
      expect(formatDate(date)).toBe('2026-11-11T12:34:56.789Z');
      expect(formatDate('2026-11-11T12:34:56.789Z')).toBe(
        '2026-11-11T12:34:56.789Z',
      );
    });

    it('mapAuction maps Auction model correctly and hides internal fields', () => {
      const dto = mapAuction(sampleAuction);

      expect(dto).toEqual({
        id: sampleAuction.id,
        productId: sampleAuction.productId,
        sellerId: sampleAuction.sellerId,
        productTitle: sampleAuction.productTitle,
        productThumbnail: sampleAuction.productThumbnail,
        startingPrice: '100000',
        currentPrice: '150000',
        bidIncrement: '10000',
        currency: 'VND',
        startTime: '2026-11-10T10:00:00.000Z',
        endTime: '2026-11-12T10:00:00.000Z',
        status: AuctionStatus.ACTIVE,
        version: 3,
        winnerId: null,
        finalPrice: null,
      });

      // Assert internal / non-contract fields are NOT present
      expect((dto as Record<string, unknown>).initializationRequest).toBeUndefined();
      expect((dto as Record<string, unknown>).initializationError).toBeUndefined();
      expect((dto as Record<string, unknown>).leadingBidderId).toBeUndefined();
      expect((dto as Record<string, unknown>).createdAt).toBeUndefined();
      expect((dto as Record<string, unknown>).updatedAt).toBeUndefined();
    });

    it('mapAuction maps ended auction with winner and finalPrice correctly', () => {
      const dto = mapAuction(sampleEndedAuction);

      expect(dto.winnerId).toBe('10000000-0000-4000-8000-000000000003');
      expect(dto.finalPrice).toBe('200000');
      expect(dto.status).toBe(AuctionStatus.ENDED);
    });

    it('mapAuction handles null productTitle, productThumbnail, and winnerId', () => {
      const dto = mapAuction(sampleInitializingAuction);

      expect(dto.productTitle).toBeNull();
      expect(dto.productThumbnail).toBeNull();
      expect(dto.winnerId).toBeNull();
      expect(dto.finalPrice).toBeNull();
    });

    it('mapBid maps Bid model correctly to Bid schema', () => {
      const dto = mapBid(sampleBid);

      expect(dto).toEqual({
        id: sampleBid.id,
        auctionId: sampleBid.auctionId,
        bidderId: sampleBid.bidderId,
        amount: '150000',
        createdAt: '2026-11-10T11:00:00.000Z',
      });
      expect(Object.keys(dto)).toEqual([
        'id',
        'auctionId',
        'bidderId',
        'amount',
        'createdAt',
      ]);
    });
  });

  describe('listAuctions', () => {
    it('hides internal statuses (INITIALIZING and CANCELLED) by default', async () => {
      mockPrisma.auction.count.mockResolvedValue(1);
      mockPrisma.auction.findMany.mockResolvedValue([sampleAuction]);

      const result = await service.listAuctions({});

      expect(mockPrisma.auction.count).toHaveBeenCalledWith({
        where: {
          status: {
            in: [
              AuctionStatus.PENDING,
              AuctionStatus.ACTIVE,
              AuctionStatus.ENDED,
            ],
          },
        },
      });
      expect(mockPrisma.auction.findMany).toHaveBeenCalledWith({
        where: {
          status: {
            in: [
              AuctionStatus.PENDING,
              AuctionStatus.ACTIVE,
              AuctionStatus.ENDED,
            ],
          },
        },
        skip: 0,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(sampleAuction.id);
    });

    it('applies custom pagination correctly', async () => {
      mockPrisma.auction.count.mockResolvedValue(55);
      mockPrisma.auction.findMany.mockResolvedValue([sampleAuction]);

      const result = await service.listAuctions({ page: 3, pageSize: 10 });

      expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 20,
          take: 10,
        }),
      );
      expect(result.page).toBe(3);
      expect(result.pageSize).toBe(10);
      expect(result.total).toBe(55);
    });

    it('clamps pagination bounds safely', async () => {
      mockPrisma.auction.count.mockResolvedValue(0);
      mockPrisma.auction.findMany.mockResolvedValue([]);

      await service.listAuctions({ page: -5, pageSize: 500 });

      expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 100, // Clamped to max 100
        }),
      );
    });

    it('filters by status when valid status is provided', async () => {
      mockPrisma.auction.count.mockResolvedValue(1);
      mockPrisma.auction.findMany.mockResolvedValue([sampleAuction]);

      const result = await service.listAuctions({ status: 'ACTIVE' });

      expect(mockPrisma.auction.count).toHaveBeenCalledWith({
        where: { status: AuctionStatus.ACTIVE },
      });
      expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: AuctionStatus.ACTIVE },
        }),
      );
      expect(result.items).toHaveLength(1);
    });

    it('throws BadRequestException (400) for invalid status', async () => {
      await expect(
        service.listAuctions({ status: 'UNKNOWN_STATUS' }),
      ).rejects.toThrow(BadRequestException);
      await expect(service.listAuctions({ status: 'active' })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.auction.count).not.toHaveBeenCalled();
    });

    it('filters by search keyword on productTitle', async () => {
      mockPrisma.auction.count.mockResolvedValue(1);
      mockPrisma.auction.findMany.mockResolvedValue([sampleAuction]);

      await service.listAuctions({ search: 'Vintage Watch' });

      expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: {
              in: [
                AuctionStatus.PENDING,
                AuctionStatus.ACTIVE,
                AuctionStatus.ENDED,
              ],
            },
            productTitle: {
              contains: 'Vintage Watch',
              mode: 'insensitive',
            },
          },
        }),
      );
    });

    it('ignores empty search query and whitespace', async () => {
      mockPrisma.auction.count.mockResolvedValue(0);
      mockPrisma.auction.findMany.mockResolvedValue([]);

      await service.listAuctions({ search: '   ' });

      expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: {
              in: [
                AuctionStatus.PENDING,
                AuctionStatus.ACTIVE,
                AuctionStatus.ENDED,
              ],
            },
          },
        }),
      );
    });

    it('combines search and status filter', async () => {
      mockPrisma.auction.count.mockResolvedValue(1);
      mockPrisma.auction.findMany.mockResolvedValue([sampleEndedAuction]);

      await service.listAuctions({ status: 'ENDED', search: 'Watch' });

      expect(mockPrisma.auction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: AuctionStatus.ENDED,
            productTitle: {
              contains: 'Watch',
              mode: 'insensitive',
            },
          },
        }),
      );
    });
  });

  describe('getAuctionById', () => {
    it('returns auction by id for ACTIVE status', async () => {
      mockPrisma.auction.findUnique.mockResolvedValue(sampleAuction);

      const result = await service.getAuctionById(sampleAuction.id);

      expect(mockPrisma.auction.findUnique).toHaveBeenCalledWith({
        where: { id: sampleAuction.id },
      });
      expect(result.id).toBe(sampleAuction.id);
      expect(result.status).toBe(AuctionStatus.ACTIVE);
      expect(result.startingPrice).toBe('100000');
    });

    it('returns auction in INITIALIZING state (allowing seller tracking)', async () => {
      mockPrisma.auction.findUnique.mockResolvedValue(sampleInitializingAuction);

      const result = await service.getAuctionById(sampleInitializingAuction.id);

      expect(result.id).toBe(sampleInitializingAuction.id);
      expect(result.status).toBe(AuctionStatus.INITIALIZING);
      expect(result.productTitle).toBeNull();
    });

    it('returns auction in CANCELLED state', async () => {
      mockPrisma.auction.findUnique.mockResolvedValue(sampleCancelledAuction);

      const result = await service.getAuctionById(sampleCancelledAuction.id);

      expect(result.id).toBe(sampleCancelledAuction.id);
      expect(result.status).toBe(AuctionStatus.CANCELLED);
    });

    it('throws NotFoundException (404) when auction does not exist', async () => {
      mockPrisma.auction.findUnique.mockResolvedValue(null);

      await expect(
        service.getAuctionById('00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getAuctionBids', () => {
    it('throws NotFoundException (404) if auction does not exist', async () => {
      mockPrisma.auction.findUnique.mockResolvedValue(null);

      await expect(
        service.getAuctionBids('00000000-0000-0000-0000-000000000000', {}),
      ).rejects.toThrow(NotFoundException);
      expect(mockPrisma.bid.findMany).not.toHaveBeenCalled();
    });

    it('returns bids sorted newest first with pagination', async () => {
      mockPrisma.auction.findUnique.mockResolvedValue({ id: sampleAuction.id });
      mockPrisma.bid.count.mockResolvedValue(1);
      mockPrisma.bid.findMany.mockResolvedValue([sampleBid]);

      const result = await service.getAuctionBids(sampleAuction.id, {
        page: 1,
        pageSize: 20,
      });

      expect(mockPrisma.bid.findMany).toHaveBeenCalledWith({
        where: { auctionId: sampleAuction.id },
        skip: 0,
        take: 20,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual({
        id: sampleBid.id,
        auctionId: sampleBid.auctionId,
        bidderId: sampleBid.bidderId,
        amount: '150000',
        createdAt: '2026-11-10T11:00:00.000Z',
      });
    });

    it('returns empty list when auction has no bids', async () => {
      mockPrisma.auction.findUnique.mockResolvedValue({ id: sampleAuction.id });
      mockPrisma.bid.count.mockResolvedValue(0);
      mockPrisma.bid.findMany.mockResolvedValue([]);

      const result = await service.getAuctionBids(sampleAuction.id, {});

      expect(result.total).toBe(0);
      expect(result.items).toEqual([]);
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
        service,
      );
      handlers.onModuleInit();
    });

    it('registers all 3 auction query operationIds', () => {
      expect(registeredHandlers.has('auction_get__api_auctions')).toBe(true);
      expect(registeredHandlers.has('auction_get__api_auctions_id')).toBe(true);
      expect(registeredHandlers.has('auction_get__api_auctions_id_bids')).toBe(
        true,
      );
    });

    it('delegates auction_get__api_auctions to listAuctions', async () => {
      const listSpy = vi
        .spyOn(service, 'listAuctions')
        .mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

      const handler = registeredHandlers.get('auction_get__api_auctions')!;
      const result = await handler({
        query: { status: 'ACTIVE', page: 2 },
      });

      expect(listSpy).toHaveBeenCalledWith({ status: 'ACTIVE', page: 2 });
      expect(result).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    });

    it('delegates auction_get__api_auctions_id to getAuctionById', async () => {
      const getSpy = vi
        .spyOn(service, 'getAuctionById')
        .mockResolvedValue(mapAuction(sampleAuction));

      const handler = registeredHandlers.get('auction_get__api_auctions_id')!;
      const result = await handler({
        params: { id: sampleAuction.id },
      });

      expect(getSpy).toHaveBeenCalledWith(sampleAuction.id);
      expect((result as { id: string }).id).toBe(sampleAuction.id);
    });

    it('delegates auction_get__api_auctions_id_bids to getAuctionBids', async () => {
      const bidsSpy = vi
        .spyOn(service, 'getAuctionBids')
        .mockResolvedValue({ items: [], page: 1, pageSize: 20, total: 0 });

      const handler = registeredHandlers.get(
        'auction_get__api_auctions_id_bids',
      )!;
      const result = await handler({
        params: { id: sampleAuction.id },
        query: { page: 1 },
      });

      expect(bidsSpy).toHaveBeenCalledWith(sampleAuction.id, { page: 1 });
      expect(result).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    });
  });
});
