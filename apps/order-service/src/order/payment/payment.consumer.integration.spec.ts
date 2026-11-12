import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { PaymentConsumer } from './payment.consumer.js';
import { loadEnv } from '../../../../../scripts/platform/env.mjs';
import { createPgDatabase, integrationEnabled } from '../../../../../tests/support/pg-database.js';
import { type IntegrationEvent, PermanentMessageError } from '../../../../../libs/common/src/index.js';

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
    'PaymentConsumer Integration - Idempotent & Rollback',
    () => {
        const pool = new pg.Pool({
            connectionString: process.env.ORDER_DATABASE_URL,
            max: 5,
        });
        const db = createPgDatabase(pool);
        const consumer = new PaymentConsumer();

        const createdOrderIds: string[] = [];

        afterAll(async () => {
            try {
                for (const orderId of createdOrderIds) {
                    await pool.query('DELETE FROM "Order" WHERE id = $1', [orderId]);
                }
            } finally {
                await pool.end();
            }
        });

        it('updates Order to PAID and handles duplicate replay safely (idempotent)', async () => {
            const orderId = randomUUID();
            const buyerId = randomUUID();
            const sellerId = randomUUID();
            const paymentId = randomUUID();
            createdOrderIds.push(orderId);

            // Tạo sẵn Order PENDING_PAYMENT
            await pool.query(
                `INSERT INTO "Order" (id, "auctionId", "productId", "buyerId", "sellerId", "totalAmount", currency, status, "productTitle", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 100000, 'VND', 'PENDING_PAYMENT', 'Test Product', now(), now())`,
                [orderId, randomUUID(), randomUUID(), buyerId, sellerId],
            );

            const event: IntegrationEvent = {
                eventId: randomUUID(),
                eventName: 'payment.succeeded',
                schemaVersion: 1,
                occurredAt: new Date().toISOString(),
                producer: 'payment',
                aggregateId: paymentId,
                aggregateVersion: 1,
                correlationId: randomUUID(),
                payload: {
                    paymentId,
                    orderId,
                    userId: buyerId,
                    amount: '100000',
                    currency: 'VND',
                    paymentMethod: 'COD',
                    transactionId: 'COD-TEST',
                    paidAt: new Date().toISOString(),
                },
            };

            // Xử lý lần 1
            await db.transaction(async (tx) => {
                await consumer.handlePaymentSucceeded(tx, event);
            });

            const res1 = await pool.query('SELECT status, "paymentId" FROM "Order" WHERE id = $1', [orderId]);
            expect(res1.rows[0].status).toBe('PAID');
            expect(res1.rows[0].paymentId).toBe(paymentId);

            // Replay lần 2 (Duplicate) -> không lỗi, không đổi trạng thái
            await db.transaction(async (tx) => {
                await consumer.handlePaymentSucceeded(tx, event);
            });

            const res2 = await pool.query('SELECT status, "paymentId" FROM "Order" WHERE id = $1', [orderId]);
            expect(res2.rows[0].status).toBe('PAID');
            expect(res2.rows[0].paymentId).toBe(paymentId);
        });

        it('rolls back completely when mismatch error occurs', async () => {
            const orderId = randomUUID();
            const buyerId = randomUUID();
            const sellerId = randomUUID();
            createdOrderIds.push(orderId);

            await pool.query(
                `INSERT INTO "Order" (id, "auctionId", "productId", "buyerId", "sellerId", "totalAmount", currency, status, "productTitle", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 200000, 'VND', 'PENDING_PAYMENT', 'Test Product 2', now(), now())`,
                [orderId, randomUUID(), randomUUID(), buyerId, sellerId],
            );

            const mismatchEvent: IntegrationEvent = {
                eventId: randomUUID(),
                eventName: 'payment.succeeded',
                schemaVersion: 1,
                occurredAt: new Date().toISOString(),
                producer: 'payment',
                aggregateId: randomUUID(),
                aggregateVersion: 1,
                correlationId: randomUUID(),
                payload: {
                    paymentId: randomUUID(),
                    orderId,
                    userId: buyerId,
                    amount: '999999', // Sai số tiền
                    currency: 'VND',
                    paymentMethod: 'COD',
                    transactionId: 'COD-TEST-2',
                    paidAt: new Date().toISOString(),
                },
            };

            await expect(
                db.transaction(async (tx) => {
                    await consumer.handlePaymentSucceeded(tx, mismatchEvent);
                }),
            ).rejects.toBeInstanceOf(PermanentMessageError);

            // Đảm bảo Order vẫn giữ nguyên PENDING_PAYMENT
            const res = await pool.query('SELECT status, "paymentId" FROM "Order" WHERE id = $1', [orderId]);
            expect(res.rows[0].status).toBe('PENDING_PAYMENT');
            expect(res.rows[0].paymentId).toBeNull();
        });
    },
);