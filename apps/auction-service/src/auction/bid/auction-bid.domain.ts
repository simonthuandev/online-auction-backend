import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';

export interface BidValidationInput {
  bidderId: string;
  sellerId: string;
  status: string;
  startTime: Date | string;
  endTime: Date | string;
  now: Date | string;
  startingPrice: string | bigint;
  currentPrice: string | bigint;
  bidIncrement: string | bigint;
  leadingBidderId: string | null;
  amount: string | bigint;
}

/**
 * Pure domain function to enforce all business bidding rules (Decision #4):
 * 1. Only when ACTIVE
 * 2. Only when now < endTime
 * 3. Seller cannot bid on their own auction (403)
 * 4. Current highest bidder cannot bid again (409)
 * 5. First bid: amount >= startingPrice (400)
 * 6. Subsequent bids: amount >= currentPrice + bidIncrement (400)
 */
export function validateBidRules(input: BidValidationInput): void {
  // 1. Auction must be ACTIVE
  if (input.status !== 'ACTIVE') {
    throw new ConflictException(
      `Auction is not active (current status: ${input.status})`,
    );
  }

  // 2. now must be before endTime
  const nowMs = new Date(input.now).getTime();
  const endMs = new Date(input.endTime).getTime();
  if (nowMs >= endMs) {
    throw new ConflictException('Auction has already ended');
  }

  // 3. Seller cannot bid on their own auction (403 Forbidden)
  if (input.bidderId === input.sellerId) {
    throw new ForbiddenException('Seller cannot bid on their own auction');
  }

  // 4. Current leader cannot bid again (409 Conflict)
  if (
    input.leadingBidderId &&
    input.leadingBidderId.trim() !== '' &&
    input.bidderId === input.leadingBidderId
  ) {
    throw new ConflictException('Current highest bidder cannot bid again');
  }

  // 5 & 6. Amount validation
  const amountBig = BigInt(input.amount);
  const startingBig = BigInt(input.startingPrice);
  const currentBig = BigInt(input.currentPrice);
  const incrementBig = BigInt(input.bidIncrement);

  if (!input.leadingBidderId || input.leadingBidderId.trim() === '') {
    // First bid rule: amount >= startingPrice
    if (amountBig < startingBig) {
      throw new BadRequestException(
        `First bid must be at least the starting price (${startingBig})`,
      );
    }
  } else {
    // Subsequent bid rule: amount >= currentPrice + bidIncrement
    const minRequired = currentBig + incrementBig;
    if (amountBig < minRequired) {
      throw new BadRequestException(
        `Bid must be at least current price + bid increment (${minRequired})`,
      );
    }
  }
}
