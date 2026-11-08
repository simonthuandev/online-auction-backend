import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { PaymentContextService } from './payment-context.service.js';
import { OrderStatus } from '@prisma/client/order/index.js';
import { Decimal } from '@prisma/client/order/runtime/library.js';

describe('PaymentContextService', () => {
    let service: PaymentContextService;
    let mockPrisma: any;

    const orderId = randomUUID();
    const buyerId = randomUUID();
    const sellerId = randomUUID();

    const mockPendingOrder = {
        id: orderId,
        auctionId: randomUUID(),
        productId: randomUUID(),
        buyerId,
        sellerId,
        totalAmount: new Decimal(15000000),
        currency: 'VND',
        status: OrderStatus.PENDING_PAYMENT,
        productTitle: 'MacBook Pro M3',
        productThumbnail: 'https://example.com/macbook.jpg',
        paymentId: null,
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    beforeEach(() => {
        mockPrisma = {
            order: {
                findUnique: vi.fn(),
            },
        };
        service = new PaymentContextService(mockPrisma);
    });

    it('200: returns payment context snapshot when order is PENDING_PAYMENT', async () => {
        mockPrisma.order.findUnique.mockResolvedValue(mockPendingOrder);

        const result = await service.getPaymentContext(orderId);

        expect(mockPrisma.order.findUnique).toHaveBeenCalledWith({
            where: { id: orderId },
        });

        expect(result).toEqual({
            orderId,
            buyerId,
            sellerId,
            amount: '15000000',
            currency: 'VND',
            status: 'PENDING_PAYMENT',
        });

        // Đảm bảo không lộ field thừa ngoài contract (additionalProperties: false)
        expect(Object.keys(result).sort()).toEqual([
            'amount',
            'buyerId',
            'currency',
            'orderId',
            'sellerId',
            'status',
        ]);
    });

    it('404: throws NotFoundException when order does not exist', async () => {
        mockPrisma.order.findUnique.mockResolvedValue(null);

        await expect(service.getPaymentContext(orderId)).rejects.toBeInstanceOf(
            NotFoundException,
        );
    });

    it('409: throws ConflictException when order status is PAID', async () => {
        mockPrisma.order.findUnique.mockResolvedValue({
            ...mockPendingOrder,
            status: OrderStatus.PAID,
        });

        await expect(service.getPaymentContext(orderId)).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('409: throws ConflictException when order status is CANCELLED', async () => {
        mockPrisma.order.findUnique.mockResolvedValue({
            ...mockPendingOrder,
            status: OrderStatus.CANCELLED,
        });

        await expect(service.getPaymentContext(orderId)).rejects.toBeInstanceOf(
            ConflictException,
        );
    });

    it('409: throws ConflictException when order status is COMPLETED', async () => {
        mockPrisma.order.findUnique.mockResolvedValue({
            ...mockPendingOrder,
            status: OrderStatus.COMPLETED,
        });

        await expect(service.getPaymentContext(orderId)).rejects.toBeInstanceOf(
            ConflictException,
        );
    });
});
