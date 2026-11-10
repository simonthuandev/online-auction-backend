import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    NotFoundException,
    ConflictException,
    ForbiddenException,
    HttpException,
} from '@nestjs/common';
import { PaymentService } from './payment.service.js';
import { InternalResponseError } from '../../../../libs/common/src/platform/internal-http.js';
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
                mockTx.query.mockResolvedValueOnce([{ requestHash: 'dummy', response: null, statusCode: null }]);
                return cb(mockTx);
            }),
        };

        mockPrisma = {
            payment: {
                findUnique: vi.fn(),
            },
            paymentAttempt: {
                update: vi.fn(),
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
            let capturedInsertAttemptSql = '';
            let capturedAttemptArgs: any[] = [];
            mockDb.transaction = vi.fn(async (cb: any) => {
                let capturedHash = '';
                const mockTx = {
                    execute: vi.fn(async (sql: string, ...args: any[]) => {
                        if (sql.includes('IdempotencyRecord')) {
                            capturedHash = args[4];
                        }
                        if (sql.includes('PaymentAttempt')) {
                            capturedInsertAttemptSql = sql;
                            capturedAttemptArgs = args;
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

            // Quyết định #8: COD hạn 7 ngày
            expect(capturedInsertAttemptSql).toContain('PaymentAttempt');
            const expiresAtIso = capturedAttemptArgs[4];
            const expiresAt = new Date(expiresAtIso).getTime();
            const now = Date.now();
            const diffDays = (expiresAt - now) / (1000 * 60 * 60 * 24);
            expect(diffDays).toBeGreaterThan(6.9);
            expect(diffDays).toBeLessThanOrEqual(7.1);
        });

        it('reuses existing pending attempt when called with same payment method', async () => {
            const existingAttemptId = randomUUID();
            const existingRef = 'txnref123';
            const futureExpiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

            mockDb.transaction = vi.fn(async (cb: any) => {
                let capturedHash = '';
                const mockTx = {
                    execute: vi.fn(async (sql: string, ...args: any[]) => {
                        if (sql.includes('IdempotencyRecord')) {
                            capturedHash = args[4];
                        }
                    }),
                    query: vi.fn(async (sql: string) => {
                        if (sql.includes('IdempotencyRecord')) {
                            return [{ requestHash: capturedHash, response: null, statusCode: null }];
                        }
                        if (sql.includes('Payment') && !sql.includes('PaymentAttempt')) {
                            return [{
                                id: paymentId,
                                orderId,
                                userId: buyerId,
                                amount: '200000',
                                currency: 'VND',
                                status: 'PENDING',
                            }];
                        }
                        if (sql.includes('PaymentAttempt')) {
                            return [{
                                id: existingAttemptId,
                                paymentId,
                                paymentMethod: 'COD',
                                providerReference: existingRef,
                                status: 'PENDING',
                                expiresAt: futureExpiresAt,
                            }];
                        }
                        return [];
                    }),
                };
                return cb(mockTx);
            });

            const result = await service.createPayment(
                { orderId, paymentMethod: 'COD' },
                'test-idempotency-key-same-method',
                { sub: buyerId, role: 'USER' } as any,
                'corr-reuse',
            );

            expect(result.orderId).toBe(orderId);
            expect(result.status).toBe('PENDING');
        });

        it('throws 409 Conflict when called with different payment method while attempt is pending (Decision #8)', async () => {
            const futureExpiresAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

            mockDb.transaction = vi.fn(async (cb: any) => {
                let capturedHash = '';
                const mockTx = {
                    execute: vi.fn(async (sql: string, ...args: any[]) => {
                        if (sql.includes('IdempotencyRecord')) {
                            capturedHash = args[4];
                        }
                    }),
                    query: vi.fn(async (sql: string) => {
                        if (sql.includes('IdempotencyRecord')) {
                            return [{ requestHash: capturedHash, response: null, statusCode: null }];
                        }
                        if (sql.includes('Payment') && !sql.includes('PaymentAttempt')) {
                            return [{
                                id: paymentId,
                                orderId,
                                userId: buyerId,
                                amount: '200000',
                                currency: 'VND',
                                status: 'PENDING',
                            }];
                        }
                        if (sql.includes('PaymentAttempt')) {
                            // Đang có COD pending
                            return [{
                                id: randomUUID(),
                                paymentId,
                                paymentMethod: 'COD',
                                providerReference: 'ref123',
                                status: 'PENDING',
                                expiresAt: futureExpiresAt,
                            }];
                        }
                        return [];
                    }),
                };
                return cb(mockTx);
            });

            // Mock VnpayGateway configured for this test
            mockVnpayGateway.isConfigured.mockReturnValue(true);
            mockVnpayGateway.buildPaymentUrl.mockReturnValue('https://sandbox.vnpayment.vn');

            await expect(
                service.createPayment(
                    { orderId, paymentMethod: 'VNPAY' },
                    'test-idempotency-key-diff-method',
                    { sub: buyerId, role: 'USER' } as any,
                    'corr-diff',
                ),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('throws 409 Conflict when payment has already succeeded', async () => {
            mockDb.transaction = vi.fn(async (cb: any) => {
                let capturedHash = '';
                const mockTx = {
                    execute: vi.fn(async (sql: string, ...args: any[]) => {
                        if (sql.includes('IdempotencyRecord')) {
                            capturedHash = args[4];
                        }
                    }),
                    query: vi.fn(async (sql: string) => {
                        if (sql.includes('IdempotencyRecord')) {
                            return [{ requestHash: capturedHash, response: null, statusCode: null }];
                        }
                        if (sql.includes('Payment') && !sql.includes('PaymentAttempt')) {
                            return [{
                                id: paymentId,
                                orderId,
                                userId: buyerId,
                                amount: '200000',
                                currency: 'VND',
                                status: 'SUCCESS',
                            }];
                        }
                        return [];
                    }),
                };
                return cb(mockTx);
            });

            await expect(
                service.createPayment(
                    { orderId, paymentMethod: 'COD' },
                    'test-idempotency-key-success',
                    { sub: buyerId, role: 'USER' } as any,
                    'corr-succ',
                ),
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('lazy expires old attempt and creates new attempt when previous attempt expired', async () => {
            const pastExpiresAt = new Date(Date.now() - 1000 * 60); // Đã hết hạn từ 1 phút trước
            let expiredUpdated = false;

            mockDb.transaction = vi.fn(async (cb: any) => {
                let capturedHash = '';
                const mockTx = {
                    execute: vi.fn(async (sql: string, ...args: any[]) => {
                        if (sql.includes('IdempotencyRecord')) {
                            capturedHash = args[4];
                        }
                        if (sql.includes('UPDATE "PaymentAttempt" SET status = \'EXPIRED\'')) {
                            expiredUpdated = true;
                        }
                    }),
                    query: vi.fn(async (sql: string) => {
                        if (sql.includes('IdempotencyRecord')) {
                            return [{ requestHash: capturedHash, response: null, statusCode: null }];
                        }
                        if (sql.includes('Payment') && !sql.includes('PaymentAttempt')) {
                            return [{
                                id: paymentId,
                                orderId,
                                userId: buyerId,
                                amount: '200000',
                                currency: 'VND',
                                status: 'PENDING',
                            }];
                        }
                        if (sql.includes('PaymentAttempt')) {
                            return [{
                                id: randomUUID(),
                                paymentId,
                                paymentMethod: 'COD',
                                providerReference: 'oldref',
                                status: 'PENDING',
                                expiresAt: pastExpiresAt,
                            }];
                        }
                        return [];
                    }),
                };
                return cb(mockTx);
            });

            const result = await service.createPayment(
                { orderId, paymentMethod: 'COD' },
                'test-idempotency-key-lazy-expire',
                { sub: buyerId, role: 'USER' } as any,
                'corr-lazy',
            );

            expect(expiredUpdated).toBe(true);
            expect(result.status).toBe('PENDING');
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

        it('lazy expires pending attempt when reading expired attempt', async () => {
            const attemptId = randomUUID();
            mockPrisma.payment.findUnique.mockResolvedValueOnce({
                id: paymentId,
                orderId,
                userId: buyerId,
                amount: new Decimal(200000),
                currency: 'VND',
                status: 'PENDING',
                attempts: [
                    {
                        id: attemptId,
                        paymentMethod: 'VNPAY',
                        providerReference: 'ref-expired',
                        status: 'PENDING',
                        expiresAt: new Date(Date.now() - 1000 * 60), // đã hết hạn
                    },
                ],
            });

            const result = await service.getPaymentByOrderId(orderId, { sub: buyerId, role: 'USER' } as any);
            expect(mockPrisma.paymentAttempt.update).toHaveBeenCalledWith({
                where: { id: attemptId },
                data: { status: 'EXPIRED' },
            });
            expect(result.paymentUrl).toBeNull();
        });
    });
});
