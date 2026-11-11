import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decideLifecycleTransition } from './lifecycle.decision.js';
import type {
  ProductLifecycleRecord,
  AuctionStartedEvent,
  AuctionEndedEvent,
} from './lifecycle.types.js';

describe('decideLifecycleTransition (Pure State Machine)', () => {
  const createMockProduct = (
    overrides?: Partial<ProductLifecycleRecord>,
  ): ProductLifecycleRecord => ({
    id: randomUUID(),
    sellerId: randomUUID(),
    status: 'RESERVED',
    reservedAuctionId: randomUUID(),
    reservationSnapshot: {
      productTitle: 'Vintage Watch',
      productThumbnail: 'https://cdn.example.test/watch.jpg',
    },
    lastAuctionVersion: 0,
    ...overrides,
  });

  const createStartedEvent = (
    auctionId: string,
    productId: string,
    aggregateVersion = 1,
  ): AuctionStartedEvent => ({
    eventId: randomUUID(),
    eventName: 'auction.started',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'auction',
    aggregateId: auctionId,
    aggregateVersion,
    correlationId: randomUUID(),
    payload: {
      auctionId,
      productId,
      sellerId: randomUUID(),
      startTime: new Date().toISOString(),
      endTime: new Date(Date.now() + 3600000).toISOString(),
    },
  });

  const createEndedEvent = (
    auctionId: string,
    productId: string,
    options?: {
      aggregateVersion?: number;
      winnerId?: string | null;
      finalPrice?: string | null;
    },
  ): AuctionEndedEvent => ({
    eventId: randomUUID(),
    eventName: 'auction.ended',
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    producer: 'auction',
    aggregateId: auctionId,
    aggregateVersion: options?.aggregateVersion ?? 2,
    correlationId: randomUUID(),
    payload: {
      auctionId,
      productId,
      productTitle: 'Vintage Watch',
      productThumbnail: 'https://cdn.example.test/watch.jpg',
      sellerId: randomUUID(),
      winnerId: options?.winnerId === undefined ? randomUUID() : options.winnerId,
      finalPrice: options?.finalPrice === undefined ? '5000000' : options.finalPrice,
      currency: 'VND',
      endedAt: new Date().toISOString(),
    },
  });

  it('1. started hợp lệ: RESERVED -> IN_AUCTION và cập nhật lastAuctionVersion', () => {
    const auctionId = randomUUID();
    const product = createMockProduct({
      status: 'RESERVED',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 0,
    });
    const event = createStartedEvent(auctionId, product.id, 1);

    const decision = decideLifecycleTransition(product, event);

    expect(decision).toEqual({
      action: 'UPDATE',
      productId: product.id,
      status: 'IN_AUCTION',
      lastAuctionVersion: 1,
      clearReservation: false,
    });
  });

  it('2. ended có winner: IN_AUCTION -> SOLD, giữ reservedAuctionId và cập nhật lastAuctionVersion', () => {
    const auctionId = randomUUID();
    const winnerId = randomUUID();
    const product = createMockProduct({
      status: 'IN_AUCTION',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 1,
    });
    const event = createEndedEvent(auctionId, product.id, {
      aggregateVersion: 2,
      winnerId,
      finalPrice: '5000000',
    });

    const decision = decideLifecycleTransition(product, event);

    expect(decision).toEqual({
      action: 'UPDATE',
      productId: product.id,
      status: 'SOLD',
      lastAuctionVersion: 2,
      clearReservation: false,
    });
  });

  it('3. ended không winner: IN_AUCTION -> READY, xóa reservedAuctionId và snapshot, cập nhật lastAuctionVersion', () => {
    const auctionId = randomUUID();
    const product = createMockProduct({
      status: 'IN_AUCTION',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 1,
    });
    const event = createEndedEvent(auctionId, product.id, {
      aggregateVersion: 2,
      winnerId: null,
      finalPrice: null,
    });

    const decision = decideLifecycleTransition(product, event);

    expect(decision).toEqual({
      action: 'UPDATE',
      productId: product.id,
      status: 'READY',
      lastAuctionVersion: 2,
      clearReservation: true,
    });
  });

  it('4. event cũ (aggregateVersion < product.lastAuctionVersion) bị ignore', () => {
    const auctionId = randomUUID();
    const product = createMockProduct({
      status: 'IN_AUCTION',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 3,
    });
    const event = createStartedEvent(auctionId, product.id, 2);

    const decision = decideLifecycleTransition(product, event);

    expect(decision).toEqual({
      action: 'IGNORE',
      reason: 'STALE_OR_DUPLICATE_VERSION',
    });
  });

  it('5. event trùng (aggregateVersion == product.lastAuctionVersion) (replay) bị ignore', () => {
    const auctionId = randomUUID();
    const product = createMockProduct({
      status: 'IN_AUCTION',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 2,
    });
    const event = createEndedEvent(auctionId, product.id, {
      aggregateVersion: 2,
    });

    const decision = decideLifecycleTransition(product, event);

    expect(decision).toEqual({
      action: 'IGNORE',
      reason: 'STALE_OR_DUPLICATE_VERSION',
    });
  });

  it('6. event của auction khác (reservedAuctionId không khớp) bị ignore', () => {
    const productAuctionId = randomUUID();
    const eventAuctionId = randomUUID();
    const product = createMockProduct({
      status: 'RESERVED',
      reservedAuctionId: productAuctionId,
      lastAuctionVersion: 0,
    });
    const event = createStartedEvent(eventAuctionId, product.id, 1);

    const decision = decideLifecycleTransition(product, event);

    expect(decision).toEqual({
      action: 'IGNORE',
      reason: 'AUCTION_ID_MISMATCH',
    });
  });

  it('6b. event lạ khi không có product nào giữ auctionId (product is null) bị ignore', () => {
    const event = createStartedEvent(randomUUID(), randomUUID(), 1);

    const decision = decideLifecycleTransition(null, event);

    expect(decision).toEqual({
      action: 'IGNORE',
      reason: 'PRODUCT_NOT_FOUND_FOR_AUCTION',
    });
  });

  it('7. ended đến trước started: ended từ RESERVED được xử lý; started đến sau với version thấp hơn bị ignore', () => {
    const auctionId = randomUUID();
    const productId = randomUUID();

    // Bước 1: Product đang RESERVED, chưa có event nào (lastAuctionVersion = 0)
    let product: ProductLifecycleRecord = createMockProduct({
      id: productId,
      status: 'RESERVED',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 0,
    });

    // Step 2: auction.ended (version 2) đến trước auction.started
    const endedEvent = createEndedEvent(auctionId, productId, {
      aggregateVersion: 2,
      winnerId: randomUUID(),
    });
    const endedDecision = decideLifecycleTransition(product, endedEvent);

    expect(endedDecision).toEqual({
      action: 'UPDATE',
      productId: product.id,
      status: 'SOLD',
      lastAuctionVersion: 2,
      clearReservation: false,
    });

    // Giả lập trạng thái sau khi cập nhật theo ended
    product = {
      ...product,
      status: 'SOLD',
      lastAuctionVersion: 2,
    };

    // Step 3: auction.started (version 1) đến muộn sau khi ended đã xử lý
    const startedEvent = createStartedEvent(auctionId, productId, 1);
    const startedDecision = decideLifecycleTransition(product, startedEvent);

    expect(startedDecision).toEqual({
      action: 'IGNORE',
      reason: 'STALE_OR_DUPLICATE_VERSION',
    });
    // Trạng thái product không bị đảo ngược về IN_AUCTION
  });

  it('8. ended từ RESERVED hợp lệ (khi started bị mất hoặc chậm trễ)', () => {
    const auctionId = randomUUID();
    const product = createMockProduct({
      status: 'RESERVED',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 0,
    });
    const endedEvent = createEndedEvent(auctionId, product.id, {
      aggregateVersion: 1,
      winnerId: null,
      finalPrice: null,
    });

    const decision = decideLifecycleTransition(product, endedEvent);

    expect(decision).toEqual({
      action: 'UPDATE',
      productId: product.id,
      status: 'READY',
      lastAuctionVersion: 1,
      clearReservation: true,
    });
  });

  it('9. auction.started bị ignore nếu product không ở RESERVED (ví dụ đã IN_AUCTION hoặc SOLD)', () => {
    const auctionId = randomUUID();
    const productInAuction = createMockProduct({
      status: 'IN_AUCTION',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 1,
    });
    const event = createStartedEvent(auctionId, productInAuction.id, 2);

    const decision = decideLifecycleTransition(productInAuction, event);

    expect(decision).toEqual({
      action: 'IGNORE',
      reason: 'INVALID_STATUS_FOR_AUCTION_STARTED',
    });
  });

  it('10. auction.ended bị ignore nếu product đã ở trạng thái kết thúc (SOLD hoặc READY)', () => {
    const auctionId = randomUUID();
    const productSold = createMockProduct({
      status: 'SOLD',
      reservedAuctionId: auctionId,
      lastAuctionVersion: 1,
    });
    const event = createEndedEvent(auctionId, productSold.id, {
      aggregateVersion: 2,
    });

    const decision = decideLifecycleTransition(productSold, event);

    expect(decision).toEqual({
      action: 'IGNORE',
      reason: 'INVALID_STATUS_FOR_AUCTION_ENDED',
    });
  });
});
