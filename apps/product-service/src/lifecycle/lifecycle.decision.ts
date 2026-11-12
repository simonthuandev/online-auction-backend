import type {
  ProductLifecycleRecord,
  LifecycleDecision,
  LifecycleEvent,
} from './lifecycle.types.js';

/**
 * Pure decision function:
 * Given product state from DB and incoming auction lifecycle event,
 * returns whether to ignore or update the product state and which fields to update.
 */
export function decideLifecycleTransition(
  product: ProductLifecycleRecord | null,
  event: LifecycleEvent,
): LifecycleDecision {
  // 1. Check if product exists and holds this auctionId
  if (!product) {
    return {
      action: 'IGNORE',
      reason: 'PRODUCT_NOT_FOUND_FOR_AUCTION',
    };
  }

  if (product.reservedAuctionId !== event.payload.auctionId) {
    return {
      action: 'IGNORE',
      reason: 'AUCTION_ID_MISMATCH',
    };
  }

  // 2. Aggregate version check: must be strictly greater than product.lastAuctionVersion
  if (event.aggregateVersion <= product.lastAuctionVersion) {
    return {
      action: 'IGNORE',
      reason: 'STALE_OR_DUPLICATE_VERSION',
    };
  }

  // 3. Event-specific status transition logic
  if (event.eventName === 'auction.started') {
    if (product.status !== 'RESERVED') {
      return {
        action: 'IGNORE',
        reason: 'INVALID_STATUS_FOR_AUCTION_STARTED',
      };
    }

    return {
      action: 'UPDATE',
      productId: product.id,
      status: 'IN_AUCTION',
      lastAuctionVersion: event.aggregateVersion,
      clearReservation: false,
    };
  }

  if (event.eventName === 'auction.ended') {
    if (product.status !== 'IN_AUCTION' && product.status !== 'RESERVED') {
      return {
        action: 'IGNORE',
        reason: 'INVALID_STATUS_FOR_AUCTION_ENDED',
      };
    }

    const hasWinner = Boolean(event.payload.winnerId);
    if (hasWinner) {
      return {
        action: 'UPDATE',
        productId: product.id,
        status: 'SOLD',
        lastAuctionVersion: event.aggregateVersion,
        clearReservation: false,
      };
    }

    return {
      action: 'UPDATE',
      productId: product.id,
      status: 'READY',
      lastAuctionVersion: event.aggregateVersion,
      clearReservation: true,
    };
  }

  return {
    action: 'IGNORE',
    reason: 'UNSUPPORTED_EVENT',
  };
}
