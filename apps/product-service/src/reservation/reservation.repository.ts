import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client/product/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReservationSnapshot } from './reservation.dto.js';

export type ReservationProductRecord = {
  id: string;
  sellerId: string;
  title: string;
  status: string;
  reservedAuctionId: string | null;
  reservationSnapshot: unknown;
  lastAuctionVersion: number;
  images: Array<{
    url: string;
    isPrimary: boolean;
  }>;
};

export type ProductTransaction = Prisma.TransactionClient;

@Injectable()
export class ReservationRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: ProductTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  async lockAndFindProduct(
    tx: ProductTransaction,
    id: string,
  ): Promise<ReservationProductRecord | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "Product" WHERE "id" = ${id} FOR UPDATE`,
    );
    if (rows.length === 0) return null;

    return tx.product.findUnique({
      where: { id },
      select: {
        id: true,
        sellerId: true,
        title: true,
        status: true,
        reservedAuctionId: true,
        reservationSnapshot: true,
        lastAuctionVersion: true,
        images: {
          select: {
            url: true,
            isPrimary: true,
          },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
  }

  async updateReservation(
    tx: ProductTransaction,
    id: string,
    auctionId: string,
    snapshot: ReservationSnapshot,
  ): Promise<void> {
    await tx.product.update({
      where: { id },
      data: {
        status: 'RESERVED',
        reservedAuctionId: auctionId,
        reservationSnapshot: snapshot as Prisma.InputJsonValue,
        lastAuctionVersion: 0,
      },
    });
  }
}
