import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  PermanentMessageError,
  type Transaction,
} from '../../../../libs/common/src/index.js';
import { LifecycleConsumer } from './lifecycle.consumer.js';
import { LifecycleRepository } from './lifecycle.repository.js';
import type { ProductLifecycleRecord } from './lifecycle.types.js';

describe('LifecycleConsumer Unit Tests', () => {
  let repository: LifecycleRepository;
  let consumer: LifecycleConsumer;
  let mockTx: Transaction;
  const lockMock = vi.fn();
  const updateMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = {
      query: vi.fn(),
      execute: vi.fn(),
    };
    repository = {
      lockAndFindProductByAuctionId: lockMock,
      updateProductLifecycle: updateMock,
    } as unknown as LifecycleRepository;
    consumer = new LifecycleConsumer(repository);
  });

  const createValidStartedEvent = (
    auctionId = randomUUID(),
    productId = randomUUID(),
    aggregateVersion = 1,
  ) => ({
    eventId: randomUUID(),
    eventName: 'auction.started' as const,
    schemaVersion: 1 as const,
    occurredAt: new Date().toISOString(),
    producer: 'auction' as const,
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

  const createValidEndedEvent = (
    auctionId = randomUUID(),
    productId = randomUUID(),
    winnerId: string | null = randomUUID(),
    aggregateVersion = 2,
  ) => ({
    eventId: randomUUID(),
    eventName: 'auction.ended' as const,
    schemaVersion: 1 as const,
    occurredAt: new Date().toISOString(),
    producer: 'auction' as const,
    aggregateId: auctionId,
    aggregateVersion,
    correlationId: randomUUID(),
    payload: {
      auctionId,
      productId,
      productTitle: 'Collector Comic',
      productThumbnail: 'https://cdn.example.test/comic.jpg',
      sellerId: randomUUID(),
      winnerId,
      finalPrice: winnerId ? '1500000' : null,
      currency: 'VND' as const,
      endedAt: new Date().toISOString(),
    },
  });

  describe('handleAuctionStarted', () => {
    it('cập nhật product khi event hợp lệ và product đang ở RESERVED', async () => {
      const auctionId = randomUUID();
      const productId = randomUUID();
      const product: ProductLifecycleRecord = {
        id: productId,
        sellerId: randomUUID(),
        status: 'RESERVED',
        reservedAuctionId: auctionId,
        reservationSnapshot: null,
        lastAuctionVersion: 0,
      };

      lockMock.mockResolvedValue(product);
      updateMock.mockResolvedValue(undefined);

      const event = createValidStartedEvent(auctionId, productId, 1);
      await consumer.handleAuctionStarted(mockTx, event);

      expect(lockMock).toHaveBeenCalledWith(mockTx, auctionId);
      expect(updateMock).toHaveBeenCalledWith(mockTx, {
        action: 'UPDATE',
        productId,
        status: 'IN_AUCTION',
        lastAuctionVersion: 1,
        clearReservation: false,
      });
    });

    it('bỏ qua và không ghi DB khi event trùng hoặc cũ (version <= lastAuctionVersion)', async () => {
      const auctionId = randomUUID();
      const productId = randomUUID();
      const product: ProductLifecycleRecord = {
        id: productId,
        sellerId: randomUUID(),
        status: 'RESERVED',
        reservedAuctionId: auctionId,
        reservationSnapshot: null,
        lastAuctionVersion: 1,
      };

      lockMock.mockResolvedValue(product);

      const event = createValidStartedEvent(auctionId, productId, 1);
      await consumer.handleAuctionStarted(mockTx, event);

      expect(updateMock).not.toHaveBeenCalled();
    });

    it('ném PermanentMessageError khi payload thiếu auctionId', async () => {
      const event = createValidStartedEvent();
      delete (event.payload as any).auctionId;

      await expect(
        consumer.handleAuctionStarted(mockTx, event as any),
      ).rejects.toThrow(PermanentMessageError);
      expect(lockMock).not.toHaveBeenCalled();
    });

    it('ném PermanentMessageError khi aggregateVersion không hợp lệ (< 1)', async () => {
      const event = createValidStartedEvent();
      (event as any).aggregateVersion = 0;

      await expect(
        consumer.handleAuctionStarted(mockTx, event as any),
      ).rejects.toThrow(PermanentMessageError);
    });

    it('ném PermanentMessageError khi eventName sai', async () => {
      const event = { ...createValidStartedEvent(), eventName: 'wrong.event' };

      await expect(
        consumer.handleAuctionStarted(mockTx, event as any),
      ).rejects.toThrow(PermanentMessageError);
    });

    it('propagate Error khi database lock query thất bại (để rollback & retry)', async () => {
      const event = createValidStartedEvent();
      lockMock.mockRejectedValue(new Error('CONNECTION_TIMEOUT'));

      await expect(
        consumer.handleAuctionStarted(mockTx, event),
      ).rejects.toThrow('CONNECTION_TIMEOUT');
    });
  });

  describe('handleAuctionEnded', () => {
    it('cập nhật SOLD khi có winner', async () => {
      const auctionId = randomUUID();
      const productId = randomUUID();
      const product: ProductLifecycleRecord = {
        id: productId,
        sellerId: randomUUID(),
        status: 'IN_AUCTION',
        reservedAuctionId: auctionId,
        reservationSnapshot: null,
        lastAuctionVersion: 1,
      };

      lockMock.mockResolvedValue(product);
      updateMock.mockResolvedValue(undefined);

      const event = createValidEndedEvent(auctionId, productId, randomUUID(), 2);
      await consumer.handleAuctionEnded(mockTx, event);

      expect(updateMock).toHaveBeenCalledWith(mockTx, {
        action: 'UPDATE',
        productId,
        status: 'SOLD',
        lastAuctionVersion: 2,
        clearReservation: false,
      });
    });

    it('cập nhật READY và clearReservation khi không có winner', async () => {
      const auctionId = randomUUID();
      const productId = randomUUID();
      const product: ProductLifecycleRecord = {
        id: productId,
        sellerId: randomUUID(),
        status: 'IN_AUCTION',
        reservedAuctionId: auctionId,
        reservationSnapshot: null,
        lastAuctionVersion: 1,
      };

      lockMock.mockResolvedValue(product);
      updateMock.mockResolvedValue(undefined);

      const event = createValidEndedEvent(auctionId, productId, null, 2);
      await consumer.handleAuctionEnded(mockTx, event);

      expect(updateMock).toHaveBeenCalledWith(mockTx, {
        action: 'UPDATE',
        productId,
        status: 'READY',
        lastAuctionVersion: 2,
        clearReservation: true,
      });
    });

    it('ném PermanentMessageError khi payload hỏng (currency không phải VND)', async () => {
      const event = createValidEndedEvent();
      (event.payload as any).currency = 'USD';

      await expect(
        consumer.handleAuctionEnded(mockTx, event as any),
      ).rejects.toThrow(PermanentMessageError);
    });

    it('ném PermanentMessageError khi missing required productTitle', async () => {
      const event = createValidEndedEvent();
      delete (event.payload as any).productTitle;

      await expect(
        consumer.handleAuctionEnded(mockTx, event as any),
      ).rejects.toThrow(PermanentMessageError);
    });
  });
});
