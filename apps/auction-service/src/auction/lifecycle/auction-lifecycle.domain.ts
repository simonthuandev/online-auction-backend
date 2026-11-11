import type { Prisma } from '@prisma/client/auction/index.js';
import { formatDecimal } from '../query/auction-query.service.js';

export interface AuctionEndCalculationInput {
  leadingBidderId: string | null;
  currentPrice: Prisma.Decimal | string | number;
}

export interface AuctionEndCalculationResult {
  winnerId: string | null;
  finalPrice: string | null;
}

/**
 * Pure domain function to decide if a PENDING auction should start.
 */
export function shouldStartAuction(
  status: string,
  startTime: Date | string,
  now: Date | string = new Date(),
): boolean {
  if (status !== 'PENDING') return false;
  return new Date(startTime).getTime() <= new Date(now).getTime();
}

/**
 * Pure domain function to decide if an ACTIVE auction should end.
 */
export function shouldEndAuction(
  status: string,
  endTime: Date | string,
  now: Date | string = new Date(),
): boolean {
  if (status !== 'ACTIVE') return false;
  return new Date(endTime).getTime() <= new Date(now).getTime();
}

/**
 * Pure domain function to compute the outcome of an ending auction:
 * - If bids were placed (leadingBidderId exists): winnerId = leadingBidderId, finalPrice = currentPrice
 * - If no bids were placed: winnerId = null, finalPrice = null
 */
export function computeAuctionEndResult(
  input: AuctionEndCalculationInput,
): AuctionEndCalculationResult {
  if (input.leadingBidderId && input.leadingBidderId.trim() !== '') {
    return {
      winnerId: input.leadingBidderId,
      finalPrice: formatDecimal(input.currentPrice),
    };
  }

  return {
    winnerId: null,
    finalPrice: null,
  };
}
