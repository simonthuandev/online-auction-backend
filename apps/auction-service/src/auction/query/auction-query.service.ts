import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  AuctionStatus,
  type Auction,
  type Bid,
  type Prisma,
} from '@prisma/client/auction/index.js';

export interface AuctionDto {
  id: string;
  productId: string;
  sellerId: string;
  productTitle: string | null;
  productThumbnail: string | null;
  startingPrice: string;
  currentPrice: string;
  bidIncrement: string;
  currency: 'VND';
  startTime: string;
  endTime: string;
  status: AuctionStatus;
  version: number;
  winnerId: string | null;
  finalPrice: string | null;
}

export interface AuctionPageDto {
  items: AuctionDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BidDto {
  id: string;
  auctionId: string;
  bidderId: string;
  amount: string;
  createdAt: string;
}

export interface BidPageDto {
  items: BidDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListAuctionsQuery {
  page?: number | string;
  pageSize?: number | string;
  categoryId?: string;
  status?: string;
  search?: string;
}

export interface ListBidsQuery {
  page?: number | string;
  pageSize?: number | string;
}

export function formatDecimal(val: Prisma.Decimal | number | string): string {
  if (
    val !== null &&
    val !== undefined &&
    typeof (val as { toFixed?: (d: number) => string }).toFixed === 'function'
  ) {
    return (val as { toFixed: (d: number) => string }).toFixed(0);
  }
  if (typeof val === 'string') {
    const parsed = Number(val);
    if (!Number.isNaN(parsed)) {
      return String(Math.round(parsed));
    }
    return val;
  }
  return String(Math.round(Number(val)));
}

export function formatDate(val: Date | string): string {
  if (val instanceof Date) {
    return val.toISOString();
  }
  return new Date(val).toISOString();
}

export function mapAuction(auction: Auction): AuctionDto {
  return {
    id: auction.id,
    productId: auction.productId,
    sellerId: auction.sellerId,
    productTitle: auction.productTitle ?? null,
    productThumbnail: auction.productThumbnail ?? null,
    startingPrice: formatDecimal(auction.startingPrice),
    currentPrice: formatDecimal(auction.currentPrice),
    bidIncrement: formatDecimal(auction.bidIncrement),
    currency: 'VND',
    startTime: formatDate(auction.startTime),
    endTime: formatDate(auction.endTime),
    status: auction.status,
    version: auction.version,
    winnerId: auction.winnerId ?? null,
    finalPrice:
      auction.finalPrice != null ? formatDecimal(auction.finalPrice) : null,
  };
}

export function mapBid(bid: Bid): BidDto {
  return {
    id: bid.id,
    auctionId: bid.auctionId,
    bidderId: bid.bidderId,
    amount: formatDecimal(bid.amount),
    createdAt: formatDate(bid.createdAt),
  };
}

@Injectable()
export class AuctionQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuctions(query: ListAuctionsQuery = {}): Promise<AuctionPageDto> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const where: Prisma.AuctionWhereInput = {};

    if (
      query.status !== undefined &&
      query.status !== null &&
      String(query.status).trim() !== ''
    ) {
      const statusStr = String(query.status).trim();
      if (!Object.values(AuctionStatus).includes(statusStr as AuctionStatus)) {
        throw new BadRequestException('Invalid status');
      }
      where.status = statusStr as AuctionStatus;
    } else {
      where.status = {
        in: [AuctionStatus.PENDING, AuctionStatus.ACTIVE, AuctionStatus.ENDED],
      };
    }

    if (
      query.search !== undefined &&
      query.search !== null &&
      String(query.search).trim() !== ''
    ) {
      where.productTitle = {
        contains: String(query.search).trim(),
        mode: 'insensitive',
      };
    }

    const [total, items] = await Promise.all([
      this.prisma.auction.count({ where }),
      this.prisma.auction.findMany({
        where,
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return {
      items: items.map(mapAuction),
      page,
      pageSize,
      total,
    };
  }

  async getAuctionById(id: string): Promise<AuctionDto> {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
    });
    if (!auction) {
      throw new NotFoundException('Auction not found');
    }
    return mapAuction(auction);
  }

  async getAuctionBids(
    id: string,
    query: ListBidsQuery = {},
  ): Promise<BidPageDto> {
    const auction = await this.prisma.auction.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!auction) {
      throw new NotFoundException('Auction not found');
    }

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [total, items] = await Promise.all([
      this.prisma.bid.count({ where: { auctionId: id } }),
      this.prisma.bid.findMany({
        where: { auctionId: id },
        skip,
        take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);

    return {
      items: items.map(mapBid),
      page,
      pageSize,
      total,
    };
  }
}
