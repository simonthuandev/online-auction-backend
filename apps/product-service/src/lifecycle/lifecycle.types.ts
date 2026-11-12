import type { IntegrationEvent } from '@app/common';

export type ProductStatus =
  | 'DRAFT'
  | 'READY'
  | 'RESERVED'
  | 'IN_AUCTION'
  | 'SOLD';

export interface ProductLifecycleRecord {
  id: string;
  sellerId: string;
  status: ProductStatus;
  reservedAuctionId: string | null;
  reservationSnapshot: unknown;
  lastAuctionVersion: number;
}

export type AuctionStartedEvent = Extract<
  IntegrationEvent,
  { eventName: 'auction.started' }
>;

export type AuctionEndedEvent = Extract<
  IntegrationEvent,
  { eventName: 'auction.ended' }
>;

export type LifecycleEvent = AuctionStartedEvent | AuctionEndedEvent;

export type LifecycleDecision =
  | {
      action: 'IGNORE';
      reason: string;
    }
  | {
      action: 'UPDATE';
      productId: string;
      status: 'IN_AUCTION' | 'SOLD' | 'READY';
      lastAuctionVersion: number;
      clearReservation: boolean;
    };
