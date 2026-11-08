import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderQueryService } from '../apps/order-service/src/order/query/order-query.service.js';
import { OrderStatus } from '@prisma/client/order/index.js';
import { Decimal } from '@prisma/client/order/runtime/library.js';

describe('OrderQueryService', () => {
    let service: OrderQueryService;
    let mockPrisma: any;

    const buyerId = randomUUID();
    const sellerId = randomUUID();
    const strangerId = randomUUID();
    const orderId = randomUUID();

    const mockOrder = {
        id: orderId,
        auctionId: randomUUID(),
        productId: randomUUID(),
        buyerId,
        sellerId,
        totalAmount: new Decimal(25000000),
        currency: 'VND',
        status: OrderStatus.PENDING_PAYMENT,
        productTitle: 'iPhone 15 Pro',
        productThumbnail: 'https://example.com/iphone.jpg',
        paymentId: null,
        paidAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    beforeEach(() => {
        mockPrisma = {
            order: {
                findMany: vi.fn().mockResolvedValue([mockOrder]),
                count: vi.fn().mockResolvedValue(1),
                findUnique: vi.fn(),
            },
        };
        service = new OrderQueryService(mockPrisma);
    });

    describe('listOrders', () => {
        it('returns orders where user is buyer or seller', async () => {
            const result = await service.listOrders(buyerId, { page: 1, pageSize: 10 });

            expect(mockPrisma.order.findMany).toHaveBeenCalledWith({
                where: {
                    OR: [{ buyerId }, { sellerId: buyerId }],
                },
                orderBy: { createdAt: 'desc' },
                skip: 0,
                take: 10,
            });

            expect(result.items.length).toBe(1);
            expect(result.total).toBe(1);
            expect(result.page).toBe(1);
            expect(result.pageSize).toBe(10);
            expect(result.items[0].totalAmount).toBe('25000000'); // Phải là chuỗi string
        });

        it('filters orders by valid status', async () => {
            await service.listOrders(sellerId, { status: OrderStatus.PAID });

            expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        OR: [{ buyerId: sellerId }, { sellerId }],
                        status: OrderStatus.PAID,
                    },
                }),
            );
        });

        it('throws BadRequestException (400) when status is invalid', async () => {
            await expect(
                service.listOrders(buyerId, { status: 'INVALID_STATUS' }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });

    describe('getOrderById', () => {
        it('allows buyer to view order detail', async () => {
            mockPrisma.order.findUnique.mockResolvedValue(mockOrder);

            const result = await service.getOrderById(buyerId, orderId);

            expect(result.id).toBe(orderId);
            expect(result.totalAmount).toBe('25000000');
        });

        it('allows seller to view order detail', async () => {
            mockPrisma.order.findUnique.mockResolvedValue(mockOrder);

            const result = await service.getOrderById(sellerId, orderId);

            expect(result.id).toBe(orderId);
        });

        it('throws NotFoundException (404) when a stranger views order detail', async () => {
            mockPrisma.order.findUnique.mockResolvedValue(mockOrder);

            await expect(
                service.getOrderById(strangerId, orderId),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('throws NotFoundException (404) when order does not exist', async () => {
            mockPrisma.order.findUnique.mockResolvedValue(null);

            await expect(
                service.getOrderById(buyerId, randomUUID()),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});
