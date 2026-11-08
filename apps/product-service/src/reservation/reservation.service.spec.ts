import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProductTransaction,
  ReservationProductRecord,
  ReservationRepository,
} from './reservation.repository.js';
import { ReservationService } from './reservation.service.js';

const tx = {} as ProductTransaction;

describe('ReservationService (Unit Tests)', () => {
  const repository = {
    transaction: vi.fn(),
    lockAndFindProduct: vi.fn(),
    updateReservation: vi.fn(),
  };

  const service = new ReservationService(
    repository as unknown as ReservationRepository,
  );

  const readyProduct: ReservationProductRecord = {
    id: 'prod-100',
    sellerId: 'seller-200',
    title: 'Vintage Film Camera',
    status: 'READY',
    reservedAuctionId: null,
    reservationSnapshot: null,
    lastAuctionVersion: 0,
    images: [
      { url: 'https://cdn.example.test/thumb.jpg', isPrimary: true },
      { url: 'https://cdn.example.test/detail.jpg', isPrimary: false },
    ],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    repository.transaction.mockImplementation(
      async (work: (transaction: ProductTransaction) => Promise<unknown>) =>
        work(tx),
    );
    repository.lockAndFindProduct.mockResolvedValue({ ...readyProduct });
    repository.updateReservation.mockResolvedValue(undefined);
  });

  describe('404: Product not found', () => {
    it('throws NotFoundException when product does not exist', async () => {
      repository.lockAndFindProduct.mockResolvedValue(null);

      await expect(
        service.reserve('prod-999', 'auction-1', 'seller-200'),
      ).rejects.toThrow(NotFoundException);

      expect(repository.updateReservation).not.toHaveBeenCalled();
    });
  });

  describe('403: Seller mismatch', () => {
    it('throws ForbiddenException when sellerId does not match product.sellerId', async () => {
      await expect(
        service.reserve('prod-100', 'auction-1', 'different-seller'),
      ).rejects.toThrow(ForbiddenException);

      expect(repository.updateReservation).not.toHaveBeenCalled();
    });
  });

  describe('409: Product not ready or reserved by another auction', () => {
    it('throws ConflictException when product status is DRAFT', async () => {
      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        status: 'DRAFT',
      });

      await expect(
        service.reserve('prod-100', 'auction-1', 'seller-200'),
      ).rejects.toThrow(ConflictException);

      expect(repository.updateReservation).not.toHaveBeenCalled();
    });

    it('throws ConflictException when product is RESERVED by a different auction', async () => {
      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        status: 'RESERVED',
        reservedAuctionId: 'other-auction-id',
      });

      await expect(
        service.reserve('prod-100', 'auction-1', 'seller-200'),
      ).rejects.toThrow(ConflictException);

      expect(repository.updateReservation).not.toHaveBeenCalled();
    });

    it('throws ConflictException when product is IN_AUCTION', async () => {
      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        status: 'IN_AUCTION',
        reservedAuctionId: 'other-auction-id',
      });

      await expect(
        service.reserve('prod-100', 'auction-1', 'seller-200'),
      ).rejects.toThrow(ConflictException);

      expect(repository.updateReservation).not.toHaveBeenCalled();
    });

    it('throws ConflictException when product is SOLD', async () => {
      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        status: 'SOLD',
      });

      await expect(
        service.reserve('prod-100', 'auction-1', 'seller-200'),
      ).rejects.toThrow(ConflictException);

      expect(repository.updateReservation).not.toHaveBeenCalled();
    });
  });

  describe('Idempotent retry with same auctionId (200)', () => {
    it('returns existing snapshot without modifying database state when called with same auctionId', async () => {
      const oldSnapshot = {
        productTitle: 'Original Title At Reservation',
        productThumbnail: 'https://cdn.example.test/original.jpg',
      };

      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        status: 'RESERVED',
        reservedAuctionId: 'auction-1',
        reservationSnapshot: oldSnapshot,
        lastAuctionVersion: 0,
      });

      const response = await service.reserve(
        'prod-100',
        'auction-1',
        'seller-200',
      );

      expect(response).toEqual({
        auctionId: 'auction-1',
        productId: 'prod-100',
        sellerId: 'seller-200',
        productTitle: 'Original Title At Reservation',
        productThumbnail: 'https://cdn.example.test/original.jpg',
      });

      // Crucial: no DB update during idempotent retry
      expect(repository.updateReservation).not.toHaveBeenCalled();
    });

    it('falls back to current product title/thumbnail if reservationSnapshot was empty on retry', async () => {
      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        status: 'RESERVED',
        reservedAuctionId: 'auction-1',
        reservationSnapshot: null,
      });

      const response = await service.reserve(
        'prod-100',
        'auction-1',
        'seller-200',
      );

      expect(response).toEqual({
        auctionId: 'auction-1',
        productId: 'prod-100',
        sellerId: 'seller-200',
        productTitle: readyProduct.title,
        productThumbnail: 'https://cdn.example.test/thumb.jpg',
      });

      expect(repository.updateReservation).not.toHaveBeenCalled();
    });
  });

  describe('Successful reservation (200)', () => {
    it('atomically reserves a READY product with primary image and resets lastAuctionVersion to 0', async () => {
      const response = await service.reserve(
        'prod-100',
        'auction-1',
        'seller-200',
      );

      expect(repository.lockAndFindProduct).toHaveBeenCalledWith(
        tx,
        'prod-100',
      );
      expect(repository.updateReservation).toHaveBeenCalledWith(
        tx,
        'prod-100',
        'auction-1',
        {
          productTitle: 'Vintage Film Camera',
          productThumbnail: 'https://cdn.example.test/thumb.jpg',
        },
      );

      expect(response).toEqual({
        auctionId: 'auction-1',
        productId: 'prod-100',
        sellerId: 'seller-200',
        productTitle: 'Vintage Film Camera',
        productThumbnail: 'https://cdn.example.test/thumb.jpg',
      });
    });

    it('sets productThumbnail to null if product has no primary image', async () => {
      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        images: [
          { url: 'https://cdn.example.test/non-primary.jpg', isPrimary: false },
        ],
      });

      const response = await service.reserve(
        'prod-100',
        'auction-1',
        'seller-200',
      );

      expect(repository.updateReservation).toHaveBeenCalledWith(
        tx,
        'prod-100',
        'auction-1',
        {
          productTitle: 'Vintage Film Camera',
          productThumbnail: null,
        },
      );

      expect(response.productThumbnail).toBeNull();
    });

    it('sets productThumbnail to null if product has empty images array', async () => {
      repository.lockAndFindProduct.mockResolvedValue({
        ...readyProduct,
        images: [],
      });

      const response = await service.reserve(
        'prod-100',
        'auction-1',
        'seller-200',
      );

      expect(response.productThumbnail).toBeNull();
    });
  });
});
