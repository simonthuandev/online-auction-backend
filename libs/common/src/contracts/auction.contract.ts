import type { AuctionStartedEvent, BidPlacedEvent, AuctionEndedEvent } from './events.generated.js';
export type AuctionStartedPayload = AuctionStartedEvent['payload'];
export type BidPlacedPayload = BidPlacedEvent['payload'];
export type AuctionEndedPayload = AuctionEndedEvent['payload'];
