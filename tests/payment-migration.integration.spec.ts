import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../scripts/platform/env.mjs';

const integration = process.env.PLATFORM_INTEGRATION === 'true';
if (integration) loadEnv();

describe.skipIf(!integration)('Payment COD migration', () => {
  it('preserves existing attempts, statuses and the pending unique index', async () => {
    const db = new pg.Client({
      connectionString: process.env.PAYMENT_DATABASE_URL,
    });
    const schema = 'cod_verify_' + randomUUID().replaceAll('-', '');
    await db.connect();
    try {
      await db.query('BEGIN');
      // Test the real migration SQL in a temporary schema. Rollback removes it;
      // the service's public tables and migration history are never modified.
      await db.query(`CREATE SCHEMA "${schema}"`);
      await db.query(`SET LOCAL search_path TO "${schema}"`);
      await db.query(
        readFileSync(
          'apps/payment-service/prisma/migrations/20261025000000_platform_foundation/migration.sql',
          'utf8',
        ),
      );
      // Seed the OLD schema before renaming the enum. COD is valid only after
      // the next migration; keep this legacy value to verify a real upgrade.
      for (const [i, method] of ['MOCK_GATEWAY', 'VNPAY'].entries()) {
        const paymentId = randomUUID();
        await db.query(
          'INSERT INTO "Payment" (id,"orderId","userId",amount,"updatedAt") VALUES ($1,$2,$3,100000,now())',
          [paymentId, randomUUID(), randomUUID()],
        );
        await db.query(
          'INSERT INTO "PaymentAttempt" (id,"paymentId","paymentMethod","providerReference",status,"expiresAt","updatedAt") VALUES ($1,$2,$3,$4,$5,now()+interval \'1 day\',now())',
          [
            randomUUID(),
            paymentId,
            method,
            randomUUID(),
            i === 0 ? 'PENDING' : 'SUCCESS',
          ],
        );
      }
      const before = (
        await db.query(
          'SELECT id,"paymentId","providerReference",status FROM "PaymentAttempt" ORDER BY id',
        )
      ).rows;
      const index = async () =>
        (
          await db.query(
            'SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2',
            [schema, 'PaymentAttempt_one_pending'],
          )
        ).rows;
      const indexBefore = await index();
      expect(indexBefore).toHaveLength(1);

      await db.query(
        readFileSync(
          'apps/payment-service/prisma/migrations/20261026000000_payment_method_cod/migration.sql',
          'utf8',
        ),
      );

      expect(
        (
          await db.query(
            'SELECT id,"paymentId","providerReference",status FROM "PaymentAttempt" ORDER BY id',
          )
        ).rows,
      ).toEqual(before);
      expect(
        (
          await db.query(
            'SELECT "paymentMethod"::text AS method FROM "PaymentAttempt" ORDER BY "paymentMethod"',
          )
        ).rows.map((row) => row.method),
      ).toEqual(['COD', 'VNPAY']);
      expect(await index()).toEqual(indexBefore);
      // The existing partial unique constraint must still enforce one pending attempt.
      await expect(
        db.query(
          'INSERT INTO "PaymentAttempt" (id,"paymentId","paymentMethod","providerReference","expiresAt","updatedAt") SELECT $1,"paymentId",\'COD\',$2,now()+interval \'1 day\',now() FROM "PaymentAttempt" WHERE status=\'PENDING\'',
          [randomUUID(), randomUUID()],
        ),
      ).rejects.toMatchObject({
        code: '23505',
        constraint: 'PaymentAttempt_one_pending',
      });
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });
});
