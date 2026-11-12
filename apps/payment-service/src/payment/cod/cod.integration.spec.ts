import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../../../../../scripts/platform/env.mjs';
import {
  createPgDatabase,
  integrationEnabled,
} from '../../../../../tests/support/pg-database.js';
import { CodService } from './cod.service.js';

if (integrationEnabled) loadEnv();

describe.skipIf(!integrationEnabled)(
  'COD Payment Confirmation Integration - Concurrency & Idempotency',
  () => {
    const pool = new pg.Pool({
      connectionString: process.env.PAYMENT_DATABASE_URL,
      max: 5,
    });
    const db = createPgDatabase(pool);
    const service = new CodService(db);

    const createdPaymentIds: string[] = [];

    afterAll(async () => {
      try {
        if (createdPaymentIds.length > 0) {
          await pool.query(
            'DELETE FROM "OutboxEvent" WHERE "aggregateId" = ANY($1)',
            [createdPaymentIds],
          );
          await pool.query(
            'DELETE FROM "PaymentAttempt" WHERE "paymentId" = ANY($1)',
            [createdPaymentIds],
          );
          await pool.query('DELETE FROM "Payment" WHERE "id" = ANY($1)', [
            createdPaymentIds,
          ]);
        }
      } finally {
        await pool.end();
      }
    });

    it('hai ADMIN confirm đồng thời chỉ sinh duy nhất một event payment.succeeded', async () => {
      const paymentId = randomUUID();
      const orderId = randomUUID();
      const userId = randomUUID();
      const attemptId = randomUUID();
      const providerReference = randomUUID().replaceAll('-', '');
      const futureExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      createdPaymentIds.push(paymentId);

      // 1. Tạo Payment PENDING
      await pool.query(
        `INSERT INTO "Payment" ("id", "orderId", "userId", "amount", "currency", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, 250000, 'VND', 'PENDING'::"PaymentStatus", now(), now())`,
        [paymentId, orderId, userId],
      );

      // 2. Tạo PaymentAttempt COD PENDING
      await pool.query(
        `INSERT INTO "PaymentAttempt" ("id", "paymentId", "paymentMethod", "providerReference", "status", "expiresAt", "createdAt", "updatedAt")
         VALUES ($1, $2, 'COD'::"PaymentMethod", $3, 'PENDING'::"PaymentStatus", $4, now(), now())`,
        [attemptId, paymentId, providerReference, futureExpiresAt],
      );

      const admin1 = { sub: randomUUID(), role: 'ADMIN' as const };
      const admin2 = { sub: randomUUID(), role: 'ADMIN' as const };
      const corr1 = randomUUID();
      const corr2 = randomUUID();

      // 3. Hai ADMIN cùng gọi confirm đồng thời
      const [result1, result2] = await Promise.all([
        service.confirmCodPayment(paymentId, admin1, corr1),
        service.confirmCodPayment(paymentId, admin2, corr2),
      ]);

      // Cả 2 đều nhận kết quả thành công 200 SUCCESS
      expect(result1.status).toBe('SUCCESS');
      expect(result2.status).toBe('SUCCESS');
      expect(result1.amount).toBe('250000');
      expect(result2.amount).toBe('250000');

      // 4. Kiểm tra OutboxEvent: CHỈ CÓ DUY NHẤT 1 event được tạo
      const outboxRows = await pool.query<{
        id: string;
        aggregateId: string;
        aggregateVersion: number;
        routingKey: string;
        envelope: {
          eventName: string;
          payload: { paymentMethod: string; transactionId: string };
        };
      }>(
        'SELECT "id", "aggregateId", "aggregateVersion", "routingKey", "envelope" FROM "OutboxEvent" WHERE "aggregateId" = $1',
        [paymentId],
      );

      expect(outboxRows.rowCount).toBe(1);
      expect(outboxRows.rows[0].aggregateVersion).toBe(1);
      expect(outboxRows.rows[0].routingKey).toBe('payment.succeeded');
      expect(outboxRows.rows[0].envelope.eventName).toBe('payment.succeeded');
      expect(outboxRows.rows[0].envelope.payload.paymentMethod).toBe('COD');
      expect(outboxRows.rows[0].envelope.payload.transactionId).toBe(
        `COD-${providerReference}`,
      );

      // 5. Kiểm tra Payment và PaymentAttempt trong DB đã SUCCESS
      const paymentRow = await pool.query<{ status: string; paidAt: Date }>(
        'SELECT "status", "paidAt" FROM "Payment" WHERE "id" = $1',
        [paymentId],
      );
      expect(paymentRow.rows[0].status).toBe('SUCCESS');
      expect(paymentRow.rows[0].paidAt).not.toBeNull();

      const attemptRow = await pool.query<{
        status: string;
        transactionId: string;
      }>(
        'SELECT "status", "transactionId" FROM "PaymentAttempt" WHERE "id" = $1',
        [attemptId],
      );
      expect(attemptRow.rows[0].status).toBe('SUCCESS');
      expect(attemptRow.rows[0].transactionId).toBe(`COD-${providerReference}`);
    });
  },
);
