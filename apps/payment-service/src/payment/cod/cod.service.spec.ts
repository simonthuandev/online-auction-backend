import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
    ForbiddenException,
    NotFoundException,
    ConflictException,
} from '@nestjs/common';
import { CodService } from './cod.service.js';

describe('CodService', () => {
    let service: CodService;
    let mockDb: any;

    const paymentId = randomUUID();
    const orderId = randomUUID();
    const userId = randomUUID();
    const attemptId = randomUUID();
    const providerRef = randomUUID().replaceAll('-', '');

    const mockAdmin = { sub: randomUUID(), role: 'ADMIN' } as any;
    const mockUser = { sub: randomUUID(), role: 'USER' } as any;

    beforeEach(() => {
        mockDb = {
            transaction: vi.fn(async (cb: any) => {
                const mockTx = {
                    execute: vi.fn(),
                    query: vi.fn(),
                };
                return cb(mockTx);
            }),
        };

        service = new CodService(mockDb);
    });

    it('throws ForbiddenException (403) when user is not ADMIN', async () => {
        await expect(
            service.confirmCodPayment(paymentId, mockUser),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException (404) when payment does not exist', async () => {
        mockDb.transaction = vi.fn(async (cb: any) => {
            const mockTx = {
                query: vi.fn().mockResolvedValueOnce([]), // Payment không tồn tại
                execute: vi.fn(),
            };
            return cb(mockTx);
        });

        await expect(
            service.confirmCodPayment(paymentId, mockAdmin),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns 200 with same result when payment was already SUCCESS by COD (idempotent)', async () => {
        mockDb.transaction = vi.fn(async (cb: any) => {
            const mockTx = {
                query: vi.fn()
                    .mockResolvedValueOnce([
                        { id: paymentId, orderId, userId, amount: '350000', currency: 'VND', status: 'SUCCESS' },
                    ])
                    .mockResolvedValueOnce([{ id: attemptId }]), // Có attempt COD SUCCESS
                execute: vi.fn(),
            };
            return cb(mockTx);
        });

        const result = await service.confirmCodPayment(paymentId, mockAdmin);

        expect(result.id).toBe(paymentId);
        expect(result.status).toBe('SUCCESS');
        expect(result.amount).toBe('350000');
    });

    it('throws ConflictException (409) when no pending COD attempt exists', async () => {
        mockDb.transaction = vi.fn(async (cb: any) => {
            const mockTx = {
                query: vi.fn()
                    .mockResolvedValueOnce([
                        { id: paymentId, orderId, userId, amount: '350000', currency: 'VND', status: 'PENDING' },
                    ])
                    .mockResolvedValueOnce([]), // Không có attempt COD PENDING
                execute: vi.fn(),
            };
            return cb(mockTx);
        });

        await expect(
            service.confirmCodPayment(paymentId, mockAdmin),
        ).rejects.toBeInstanceOf(ConflictException);
    });

    it('throws ConflictException (409) and marks attempt EXPIRED when attempt is expired', async () => {
        const expiredDate = new Date(Date.now() - 1000); // Đã hết hạn 1s trước
        let executedSql = '';

        mockDb.transaction = vi.fn(async (cb: any) => {
            const mockTx = {
                query: vi.fn()
                    .mockResolvedValueOnce([
                        { id: paymentId, orderId, userId, amount: '350000', currency: 'VND', status: 'PENDING' },
                    ])
                    .mockResolvedValueOnce([
                        {
                            id: attemptId,
                            paymentId,
                            paymentMethod: 'COD',
                            providerReference: providerRef,
                            status: 'PENDING',
                            expiresAt: expiredDate,
                        },
                    ]),
                execute: vi.fn().mockImplementation(async (sql) => {
                    executedSql = sql;
                }),
            };
            return cb(mockTx);
        });

        await expect(
            service.confirmCodPayment(paymentId, mockAdmin),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(executedSql).toContain('UPDATE "PaymentAttempt" SET status = \'EXPIRED\'');
    });

    it('confirms COD payment successfully: updates SUCCESS and enqueues payment.succeeded', async () => {
        const validDate = new Date(Date.now() + 60 * 60 * 1000); // Còn hạn 1 tiếng
        const executedSqls: string[] = [];

        mockDb.transaction = vi.fn(async (cb: any) => {
            const mockTx = {
                query: vi.fn()
                    .mockResolvedValueOnce([
                        { id: paymentId, orderId, userId, amount: '350000', currency: 'VND', status: 'PENDING' },
                    ])
                    .mockResolvedValueOnce([
                        {
                            id: attemptId,
                            paymentId,
                            paymentMethod: 'COD',
                            providerReference: providerRef,
                            status: 'PENDING',
                            expiresAt: validDate,
                        },
                    ]),
                execute: vi.fn().mockImplementation(async (sql) => {
                    executedSqls.push(sql);
                }),
            };
            return cb(mockTx);
        });

        const result = await service.confirmCodPayment(paymentId, mockAdmin, randomUUID());

        expect(result.id).toBe(paymentId);
        expect(result.status).toBe('SUCCESS');
        expect(result.amount).toBe('350000');
        expect(result.paymentUrl).toBeNull();

        // Kiểm tra đã execute cập nhật attempt, payment và chèn OutboxEvent
        expect(executedSqls.some((s) => s.includes('UPDATE "PaymentAttempt"'))).toBe(true);
        expect(executedSqls.some((s) => s.includes('UPDATE "Payment"'))).toBe(true);
        expect(executedSqls.some((s) => s.includes('INSERT INTO "OutboxEvent"'))).toBe(true);
    });
});
