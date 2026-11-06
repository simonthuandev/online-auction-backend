import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OrderConsumer } from '../apps/order-service/src/order/order.consumer.js';
import {
    IntegrationEvent,
    PermanentMessageError,
    type Transaction,
} from '@app/common';

type AuctionEndedEvent = Extract<IntegrationEvent, { eventName: 'auction.ended' }>;

describe('OrderConsumer - auction.ended', () => {
    let consumer: OrderConsumer;
    let mockTx: Transaction;

    const validEvent: AuctionEndedEvent = {
        eventId: randomUUID(),
        eventName: 'auction.ended',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'auction',
        aggregateId: randomUUID(),
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: {
            auctionId: randomUUID(),
            productId: randomUUID(),
            productTitle: 'MacBook Pro M3',
            productThumbnail: 'https://example.com/macbook.jpg',
            sellerId: randomUUID(),
            winnerId: randomUUID(),
            finalPrice: '35000000',
            currency: 'VND',
            endedAt: new Date().toISOString(),
        },
    };

    beforeEach(() => {
        consumer = new OrderConsumer();
        mockTx = {
            execute: vi.fn().mockResolvedValue(1),
            query: vi.fn().mockResolvedValue([]),
        };
    });

    it('maps valid payload to Order insert query with buyerId = winnerId', async () => {
        await consumer.handleAuctionEnded(mockTx, validEvent);

        expect(mockTx.execute).toHaveBeenCalledTimes(1);
        const [sql, ...params] = (mockTx.execute as any).mock.calls[0];

        expect(sql).toContain('INSERT INTO "Order"');
        expect(sql).toContain('ON CONFLICT ("auctionId") DO NOTHING');

        // params[0] là id ngẫu nhiên (UUID)
        expect(params[0]).toBeTypeOf('string');
        expect(params[1]).toBe(validEvent.payload.auctionId);
        expect(params[2]).toBe(validEvent.payload.productId);
        expect(params[3]).toBe(validEvent.payload.winnerId); // Buyer chính là Winner
        expect(params[4]).toBe(validEvent.payload.sellerId);
        expect(params[5]).toBe(validEvent.payload.finalPrice);
        expect(params[6]).toBe('VND');
        expect(params[7]).toBe('MacBook Pro M3');
        expect(params[8]).toBe('https://example.com/macbook.jpg');
    });

    it('skips order creation when winnerId or finalPrice is null (no-winner)', async () => {
        const noWinnerEvent: AuctionEndedEvent = {
            ...validEvent,
            payload: {
                ...validEvent.payload,
                winnerId: null,
                finalPrice: null,
            },
        };

        await expect(consumer.handleAuctionEnded(mockTx, noWinnerEvent)).resolves.toBeUndefined();
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('throws PermanentMessageError when finalPrice is <= 0', async () => {
        const zeroPriceEvent: AuctionEndedEvent = {
            ...validEvent,
            payload: {
                ...validEvent.payload,
                finalPrice: '0',
            },
        };

        await expect(consumer.handleAuctionEnded(mockTx, zeroPriceEvent)).rejects.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('throws PermanentMessageError when missing required fields', async () => {
        const missingFieldEvent = {
            ...validEvent,
            payload: {
                ...validEvent.payload,
                auctionId: '', // rỗng
            },
        };

        await expect(consumer.handleAuctionEnded(mockTx, missingFieldEvent)).rejects.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });
});