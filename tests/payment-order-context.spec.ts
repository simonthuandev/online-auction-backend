import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    NotFoundException,
    ConflictException,
    ForbiddenException,
    HttpException,
} from '@nestjs/common';
import { PaymentService } from '../apps/payment-service/src/payment/payment.service.js';
import { VnpayGateway } from '../apps/payment-service/src/payment/vnpay.gateway.js';
import { InternalResponseError } from '../libs/common/src/platform/internal-http.js';
import { Decimal } from '@prisma/client/payment/runtime/library.js';

describe('PaymentService', () => {
    let service: PaymentService;
    let mockDb: any;
    let mockPrisma: any;
    let mockInternalHttp: any;
    let mockVnpayGateway: any;

    const buyerId = randomUUID();
    const strangerId = randomUUID();
    const orderId = randomUUID();
    const paymentId = randomUUID();

    const mockOrderContext = {
        orderId,
        buyerId,
        sellerId: randomUUID(),
        amount: '200000',
        currency: 'VND' as const,
        status: 'PENDING_PAYMENT' as const,
    };

    beforeEach(() => {
        mockDb = {
            transaction: vi.fn(async (cb: any) => {
                const mockTx = {
                    query: vi.fn(),
                    execute: vi.fn(),
                };
                // Giả lập IdempotencyRecord
                mockTx.query.mockResolvedValueOnce([{ requestHash: 'dummy', response: null, statusCode: null }]);
                return cb(mockTx);
            }),
        };

        mockPrisma = {
            payment: {
                findUnique: vi.fn(),
            },
        };

        mockInternalHttp = {
            paymentContext: vi.fn().mockResolvedValue(mockOrderContext),
        };

        mockVnpayGateway = {
            isConfigured: vi.fn().mockReturnValue(false),
            buildPaymentUrl: vi.fn().mockImplementation(() => {
                throw new HttpException('FEATURE_NOT_IMPLEMENTED', 501);
            }),
        };

        service = new PaymentService(
            mockDb,
            mockPrisma,
            mockInternalHttp,
            mockVnpayGateway,
        );
    });

    describe('createPayment', () => {
        it('throws NotFoundException when order does not exist (404)', async () => {
            mockInternalHttp.paymentContext.mockRejectedValueOnce(
                new InternalResponseError(404, 'Order not found'),
            );

            await expect(
                service.createPayment(
                    { orderId, paymentMethod: 'COD' },
                    'test-key-1',
                    { sub: buyerId, role: 'USER' } as any,
                    'corr-1',
                ),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('throws ConflictException when order is not PENDING_PAYMENT (409)', async () => {
            mockInternalHttp.paymentContext.mockRejectedValueOnce(
                new InternalResponseError(409, 'Conflict'),
            );

            await expect(
                service.createPayment(
                    { orderId, paymentMethod: 'COD' },
                    'test-key-2',
                    { sub: buyerId, role: 'USER' } as any,
                    'corr-2',
                ),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('throws ForbiddenException when user is not the buyer (403)', async () => {
            await expect(
                service.createPayment(
                    { orderId, paymentMethod: 'COD' },
                    'test-key-3',
                    { sub: strangerId, role: 'USER' } as any,
                    'corr-3',
                ),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('throws 501 before creating attempt when VNPAY is not configured', async () => {
            await expect(
                service.createPayment(
                    { orderId, paymentMethod: 'VNPAY' },
                    'test-key-4',
                    { sub: buyerId, role: 'USER' } as any,
                    'corr-4',
                ),
            ).rejects.toThrow();

            // Đảm bảo không mở transaction DB
            expect(mockDb.transaction).not.toHaveBeenCalled();
        });

        it('creates COD payment successfully when order is valid', async () => {
            mockDb.transaction = vi.fn(async (cb: any) => {
                let capturedHash = '';
                const mockTx = {
                    execute: vi.fn(async (sql: string, ...args: any[]) => {
                        if (sql.includes('IdempotencyRecord')) {
                            capturedHash = args[4]; // Bắt hash thực tế từ withIdempotency
                        }
                    }),
                    query: vi.fn(async (sql: string) => {
                        if (sql.includes('IdempotencyRecord')) {
                            return [{ requestHash: capturedHash, response: null, statusCode: null }];
                        }
                        return []; // Không có payment hay attempt cũ
                    }),
                };
                return cb(mockTx);
            });
            const result = await service.createPayment(
                { orderId, paymentMethod: 'COD' },
                'test-idempotency-key',
                { sub: buyerId, role: 'USER' } as any,
                'corr-5',
            );
            expect(result.orderId).toBe(orderId);
            expect(result.userId).toBe(buyerId);
            expect(result.amount).toBe('200000');
            expect(result.status).toBe('PENDING');
            expect(result.paymentUrl).toBeNull();
        });
    });

    describe('getPaymentByOrderId', () => {
        it('throws NotFoundException when payment does not exist (404)', async () => {
            mockPrisma.payment.findUnique.mockResolvedValueOnce(null);

            await expect(
                service.getPaymentByOrderId(orderId, { sub: buyerId, role: 'USER' } as any),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('throws ForbiddenException when stranger views payment (403)', async () => {
            mockPrisma.payment.findUnique.mockResolvedValueOnce({
                id: paymentId,
                orderId,
                userId: buyerId,
                amount: new Decimal(200000),
                currency: 'VND',
                status: 'PENDING',
                attempts: [],
            });

            await expect(
                service.getPaymentByOrderId(orderId, { sub: strangerId, role: 'USER' } as any),
            ).rejects.toBeInstanceOf(ForbiddenException);
        });

        it('allows buyer to view payment (200)', async () => {
            mockPrisma.payment.findUnique.mockResolvedValueOnce({
                id: paymentId,
                orderId,
                userId: buyerId,
                amount: new Decimal(200000),
                currency: 'VND',
                status: 'PENDING',
                attempts: [],
            });

            const result = await service.getPaymentByOrderId(orderId, { sub: buyerId, role: 'USER' } as any);
            expect(result.id).toBe(paymentId);
            expect(result.amount).toBe('200000');
        });

        it('allows ADMIN to view payment (200)', async () => {
            mockPrisma.payment.findUnique.mockResolvedValueOnce({
                id: paymentId,
                orderId,
                userId: buyerId,
                amount: new Decimal(200000),
                currency: 'VND',
                status: 'PENDING',
                attempts: [],
            });

            const result = await service.getPaymentByOrderId(orderId, { sub: strangerId, role: 'ADMIN' } as any);
            expect(result.id).toBe(paymentId);
            expect(result.amount).toBe('200000');
        });
    });
});
