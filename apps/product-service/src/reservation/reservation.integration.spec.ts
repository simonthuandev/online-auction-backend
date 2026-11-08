import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReservationRepository } from './reservation.repository.js';
import { ReservationService } from './reservation.service.js';
import { loadEnv } from '../../../../scripts/platform/env.mjs';
import { integrationEnabled } from '../../../../tests/support/pg-database.js';

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
  'Product Reservation Integration - Concurrent Auctions & Idempotency',
  () => {
    let prisma: PrismaService;
    let repository: ReservationRepository;
    let service: ReservationService;

    const createdProductIds: string[] = [];
    const createdCategoryIds: string[] = [];
    const sellerId = randomUUID();

    beforeAll(async () => {
      prisma = new PrismaService();
      await prisma.$connect();
      repository = new ReservationRepository(prisma);
      service = new ReservationService(repository);
    });

    afterAll(async () => {
      try {
        if (createdProductIds.length > 0) {
          await prisma.productImage.deleteMany({
            where: { productId: { in: createdProductIds } },
          });
          await prisma.product.deleteMany({
            where: { id: { in: createdProductIds } },
          });
        }
        if (createdCategoryIds.length > 0) {
          await prisma.category.deleteMany({
            where: { id: { in: createdCategoryIds } },
          });
        }
      } finally {
        await prisma.$disconnect();
      }
    });

    it('ensures only one auction succeeds when two reservations compete concurrently for the same product', async () => {
      const category = await prisma.category.create({
        data: {
          name: `Category-${randomUUID()}`,
          description: 'Integration test category',
        },
      });
      createdCategoryIds.push(category.id);

      const product = await prisma.product.create({
        data: {
          sellerId,
          categoryId: category.id,
          title: 'Concurrent Antique Clock',
          description: 'Rare pendulum clock',
          status: 'READY',
          condition: 'NEW',
          lastAuctionVersion: 5,
          images: {
            create: [
              {
                url: 'https://cdn.example.test/clock-primary.jpg',
                isPrimary: true,
              },
              {
                url: 'https://cdn.example.test/clock-detail.jpg',
                isPrimary: false,
              },
            ],
          },
        },
      });
      createdProductIds.push(product.id);

      const auctionId1 = randomUUID();
      const auctionId2 = randomUUID();

      // Launch both reservations simultaneously
      const results = await Promise.allSettled([
        service.reserve(product.id, auctionId1, sellerId),
        service.reserve(product.id, auctionId2, sellerId),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      // Exactly one must succeed
      expect(fulfilled).toHaveLength(1);
      // Exactly one must fail with 409 ConflictException
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);

      const winnerAuctionId = fulfilled[0].value.auctionId;
      expect([auctionId1, auctionId2]).toContain(winnerAuctionId);
      expect(fulfilled[0].value).toMatchObject({
        productId: product.id,
        sellerId,
        productTitle: 'Concurrent Antique Clock',
        productThumbnail: 'https://cdn.example.test/clock-primary.jpg',
      });

      // Verify database record
      const updatedProduct = await prisma.product.findUnique({
        where: { id: product.id },
      });
      expect(updatedProduct).not.toBeNull();
      expect(updatedProduct!.status).toBe('RESERVED');
      expect(updatedProduct!.reservedAuctionId).toBe(winnerAuctionId);
      expect(updatedProduct!.lastAuctionVersion).toBe(0);
      expect(updatedProduct!.reservationSnapshot).toEqual({
        productTitle: 'Concurrent Antique Clock',
        productThumbnail: 'https://cdn.example.test/clock-primary.jpg',
      });

      // Idempotent retry: Calling again with the winning auctionId returns 200 without changing state
      const retryResult = await service.reserve(
        product.id,
        winnerAuctionId,
        sellerId,
      );
      expect(retryResult).toEqual(fulfilled[0].value);

      // Another auction attempting to reserve now also gets 409 ConflictException
      const auctionId3 = randomUUID();
      await expect(
        service.reserve(product.id, auctionId3, sellerId),
      ).rejects.toThrow(ConflictException);
    });
  },
);
