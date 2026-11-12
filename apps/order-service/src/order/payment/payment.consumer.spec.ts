import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PaymentConsumer, type PaymentSucceededPayload } from './payment.consumer.js';
import {
    type IntegrationEvent,
    PermanentMessageError,
    type Transaction,
} from '../../../../../libs/common/src/index.js';

describe('PaymentConsumer - payment.succeeded', () => {
    let consumer: PaymentConsumer;
    let mockTx: Transaction;

    const orderId = randomUUID();
    const paymentId = randomUUID();
    const buyerId = randomUUID();

    const validPayload: PaymentSucceededPayload = {
        paymentId,
        orderId,
        userId: buyerId,
        amount: '500000',
        currency: 'VND',
        paymentMethod: 'COD',
        transactionId: 'COD-123456',
        paidAt: new Date().toISOString(),
    };

    const validEvent: IntegrationEvent = {
        eventId: randomUUID(),
        eventName: 'payment.succeeded',
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        producer: 'payment',
        aggregateId: paymentId,
        aggregateVersion: 1,
        correlationId: randomUUID(),
        payload: validPayload,
    };

    const mockPendingOrder = {
        id: orderId,
        buyerId,
        sellerId: randomUUID(),
        totalAmount: '500000',
        currency: 'VND',
        status: 'PENDING_PAYMENT',
        paymentId: null,
        paidAt: null,
    };

    beforeEach(() => {
        consumer = new PaymentConsumer();
        mockTx = {
            execute: vi.fn().mockResolvedValue(1),
            query: vi.fn(),
        };
    });

    it('updates Order to PAID when payload is valid and matches order snapshot', async () => {
        (mockTx.query as any).mockResolvedValueOnce([mockPendingOrder]);

        await consumer.handlePaymentSucceeded(mockTx, validEvent);

        expect(mockTx.execute).toHaveBeenCalledTimes(1);
        const [sql, ...params] = (mockTx.execute as any).mock.calls[0];

        expect(sql).toContain('UPDATE "Order" SET status = \'PAID\'');
        expect(params[0]).toBe(paymentId);
        expect(params[2]).toBe(orderId);
    });

    it('throws regular Error to trigger RabbitMQ retry when order does not exist', async () => {
        (mockTx.query as any).mockResolvedValueOnce([]); // Order không tìm thấy

        await expect(consumer.handlePaymentSucceeded(mockTx, validEvent)).rejects.toThrow(
            /ORDER_NOT_FOUND/,
        );
        // Phải là Error thông thường, không phải PermanentMessageError
        await expect(consumer.handlePaymentSucceeded(mockTx, validEvent)).rejects.not.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('throws PermanentMessageError when order is CANCELLED', async () => {
        (mockTx.query as any).mockResolvedValueOnce([
            { ...mockPendingOrder, status: 'CANCELLED' },
        ]);

        await expect(consumer.handlePaymentSucceeded(mockTx, validEvent)).rejects.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('throws PermanentMessageError (PAYMENT_ORDER_MISMATCH) when buyerId does not match', async () => {
        (mockTx.query as any).mockResolvedValueOnce([
            { ...mockPendingOrder, buyerId: randomUUID() }, // Khác buyerId
        ]);

        await expect(consumer.handlePaymentSucceeded(mockTx, validEvent)).rejects.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('throws PermanentMessageError (PAYMENT_ORDER_MISMATCH) when amount does not match', async () => {
        (mockTx.query as any).mockResolvedValueOnce([
            { ...mockPendingOrder, totalAmount: '999999' }, // Khác số tiền
        ]);

        await expect(consumer.handlePaymentSucceeded(mockTx, validEvent)).rejects.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('throws PermanentMessageError (PAYMENT_ORDER_MISMATCH) when currency does not match', async () => {
        (mockTx.query as any).mockResolvedValueOnce([
            { ...mockPendingOrder, currency: 'USD' }, // Khác loại tiền
        ]);

        await expect(consumer.handlePaymentSucceeded(mockTx, validEvent)).rejects.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('is no-op when order is already PAID with same paymentId', async () => {
        (mockTx.query as any).mockResolvedValueOnce([
            { ...mockPendingOrder, status: 'PAID', paymentId },
        ]);

        await consumer.handlePaymentSucceeded(mockTx, validEvent);

        // Không chạy thêm lệnh UPDATE nào
        expect(mockTx.execute).not.toHaveBeenCalled();
    });

    it('throws PermanentMessageError when order is already PAID with different paymentId', async () => {
        (mockTx.query as any).mockResolvedValueOnce([
            { ...mockPendingOrder, status: 'PAID', paymentId: randomUUID() }, // paymentId khác
        ]);

        await expect(consumer.handlePaymentSucceeded(mockTx, validEvent)).rejects.toBeInstanceOf(
            PermanentMessageError,
        );
        expect(mockTx.execute).not.toHaveBeenCalled();
    });
});
