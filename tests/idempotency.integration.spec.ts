import { afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { withIdempotency } from '../libs/common/src/platform/idempotency.js';
import type { Transaction } from '../libs/common/src/platform/database.js';
import { loadEnv } from '../scripts/platform/env.mjs';
import {
  cleanupRunData,
  createPgDatabase,
  integrationEnabled,
} from './support/pg-database.js';
if (integrationEnabled) loadEnv();
const runId = randomUUID();
let pool: pg.Pool;
let db: ReturnType<typeof createPgDatabase>;
describe.skipIf(!integrationEnabled)(
  'PostgreSQL idempotency and rollback',
  () => {
    pool = new pg.Pool({
      connectionString: process.env.AUCTION_DATABASE_URL,
      max: 5,
    });
    db = createPgDatabase(pool);
    afterAll(async () => {
      try {
        await cleanupRunData(pool, runId);
      } finally {
        await pool.end();
      }
    });
    it('serializes concurrent duplicate requests and detects different bodies', async () => {
      const business = vi.fn(async (tx: Transaction) => {
        await new Promise((r) => setTimeout(r, 25));
        await tx.execute(
          'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb)',
          randomUUID(),
          runId,
          'idempotency',
          '{"ok":true}',
        );
        return { id: 'same-response' };
      });
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          withIdempotency(
            db,
            runId,
            'test',
            'same-key',
            { a: 1, b: 2 },
            202,
            business,
          ),
        ),
      );
      expect(business).toHaveBeenCalledTimes(1);
      expect(new Set(results.map((x) => JSON.stringify(x))).size).toBe(1);
      await expect(
        withIdempotency(db, runId, 'test', 'same-key', { a: 2 }, 202, business),
      ).rejects.toThrow();
    });
    it('rolls back the reservation and business write together', async () => {
      await expect(
        withIdempotency(
          db,
          runId,
          'rollback',
          'rollback-key',
          {},
          201,
          async (tx) => {
            await tx.execute(
              'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb)',
              randomUUID(),
              runId,
              'rollback',
              '{}',
            );
            throw Error('abort');
          },
        ),
      ).rejects.toThrow('abort');
      expect(
        (
          await db.query(
            'SELECT id FROM "PlatformProbe" WHERE "runId"=$1 AND kind=$2',
            runId,
            'rollback',
          )
        ).length,
      ).toBe(0);
      expect(
        (
          await db.query(
            'SELECT id FROM "IdempotencyRecord" WHERE "actorId"=$1 AND operation=$2',
            runId,
            'rollback',
          )
        ).length,
      ).toBe(0);
      const result = await withIdempotency(
        db,
        runId,
        'rollback',
        'rollback-key',
        {},
        201,
        async () => ({ recovered: true }),
      );
      expect(result.response.recovered).toBe(true);
    });
  },
);

describe.skipIf(!integrationEnabled)(
  'consumer atomicity and after-commit delivery',
  () => {
    it('rolls back dedupe on failure, retries once, and emits only after commit', async () => {
      const { Messaging, EventHandlers } =
        await import('../libs/common/src/platform/messaging.js');
      const pool = new pg.Pool({
        connectionString: process.env.ORDER_DATABASE_URL,
      });
      const run = randomUUID();
      const consumer = 'verify:' + run;
      const database = createPgDatabase(pool);
      const registry = new EventHandlers();
      let fail = true;
      let emissions = 0;
      registry.register('auction.ended', async (tx) => {
        await tx.execute(
          'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb)',
          randomUUID(),
          run,
          'atomic-consumer',
          '{}',
        );
        if (fail) throw Error('retry me');
        return async () => {
          expect(
            (
              await database.query(
                'SELECT id FROM "PlatformProbe" WHERE "runId"=$1',
                run,
              )
            ).length,
          ).toBe(1);
          emissions++;
        };
      });
      const messaging = new Messaging(
        database,
        {} as never,
        registry,
        {} as never,
      );
      const event = {
        eventId: run,
        eventName: 'auction.ended' as const,
        schemaVersion: 1 as const,
        occurredAt: new Date().toISOString(),
        producer: 'auction' as const,
        aggregateId: run,
        aggregateVersion: 1,
        correlationId: run,
        payload: {
          auctionId: run,
          productId: run,
          productTitle: 'fixture',
          productThumbnail: null,
          sellerId: run,
          winnerId: run,
          finalPrice: '100000',
          currency: 'VND' as const,
          endedAt: new Date().toISOString(),
        },
      };
      try {
        await expect(messaging.handle(consumer, event)).rejects.toThrow(
          'retry me',
        );
        expect(
          (
            await database.query(
              'SELECT "eventId" FROM "ProcessedEvent" WHERE "consumerName"=$1',
              consumer,
            )
          ).length,
        ).toBe(0);
        expect(emissions).toBe(0);
        fail = false;
        await messaging.handle(consumer, event);
        await messaging.handle(consumer, event);
        expect(emissions).toBe(1);
      } finally {
        try {
          await cleanupRunData(pool, run);
        } finally {
          await pool.end();
        }
      }
    });
  },
);
