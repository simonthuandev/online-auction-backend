import pg from 'pg';
import type {
  Database,
  Transaction,
} from '../../libs/common/src/platform/database.js';

export const integrationEnabled = process.env.PLATFORM_INTEGRATION === 'true';

const query =
  (client: pg.Pool | pg.PoolClient) =>
  <T>(sql: string, ...values: unknown[]) =>
    client.query(sql, values).then((result) => result.rows as T[]);

const execute =
  (client: pg.Pool | pg.PoolClient) =>
  (sql: string, ...values: unknown[]) =>
    client.query(sql, values).then((result) => result.rowCount || 0);

export function createPgDatabase(pool: pg.Pool): Database {
  return {
    query: <T>(sql: string, ...values: unknown[]) =>
      query(pool)<T>(sql, ...values),
    execute: (sql, ...values) => execute(pool)(sql, ...values),
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          query: query(client),
          execute: execute(client),
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function cleanupRunData(
  pool: pg.Pool,
  runId: string,
): Promise<void> {
  const { rows } = await pool.query<{
    hasPlatformProbe: boolean;
    hasIdempotencyRecord: boolean;
    hasProcessedEvent: boolean;
  }>(`
    SELECT
      to_regclass('"PlatformProbe"') IS NOT NULL AS "hasPlatformProbe",
      to_regclass('"IdempotencyRecord"') IS NOT NULL AS "hasIdempotencyRecord",
      to_regclass('"ProcessedEvent"') IS NOT NULL AS "hasProcessedEvent"
  `);
  const tables = rows[0];

  if (tables.hasPlatformProbe)
    await pool.query('DELETE FROM "PlatformProbe" WHERE "runId"=$1', [runId]);
  if (tables.hasIdempotencyRecord)
    await pool.query('DELETE FROM "IdempotencyRecord" WHERE "actorId"=$1', [
      runId,
    ]);
  if (tables.hasProcessedEvent)
    await pool.query(
      'DELETE FROM "ProcessedEvent" WHERE "eventId"=$1 OR position($1 in "consumerName") > 0',
      [runId],
    );
}
