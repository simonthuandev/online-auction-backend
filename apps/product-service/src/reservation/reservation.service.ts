import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ReservationResponse,
  ReservationSnapshot,
} from './reservation.dto.js';
import { ReservationRepository } from './reservation.repository.js';

@Injectable()
export class ReservationService {
  constructor(private readonly repository: ReservationRepository) {}

  async reserve(
    productId: string,
    auctionId: string,
    sellerId: string,
  ): Promise<ReservationResponse> {
    return this.repository.transaction(async (tx) => {
      const product = await this.repository.lockAndFindProduct(tx, productId);
      if (!product) {
        throw new NotFoundException('Product not found');
      }

      if (product.sellerId !== sellerId) {
        throw new ForbiddenException('Product belongs to another seller');
      }

      if (product.reservedAuctionId === auctionId) {
        const existingSnapshot =
          product.reservationSnapshot as ReservationSnapshot | null;
        return {
          auctionId,
          productId: product.id,
          sellerId: product.sellerId,
          productTitle: existingSnapshot?.productTitle ?? product.title,
          productThumbnail:
            existingSnapshot?.productThumbnail ??
            product.images.find((image) => image.isPrimary)?.url ??
            null,
        };
      }

      if (product.status !== 'READY') {
        throw new ConflictException('Product is not ready for reservation');
      }

      const primaryImage = product.images.find((image) => image.isPrimary);
      const productThumbnail = primaryImage ? primaryImage.url : null;
      const snapshot: ReservationSnapshot = {
        productTitle: product.title,
        productThumbnail,
      };

      await this.repository.updateReservation(
        tx,
        productId,
        auctionId,
        snapshot,
      );

      return {
        auctionId,
        productId: product.id,
        sellerId: product.sellerId,
        productTitle: product.title,
        productThumbnail,
      };
    });
  }
}
