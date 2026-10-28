import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from './database.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
/** Runs the business write and its recorded response in one local transaction. */
export async function withIdempotency<T>(
  db: Database,
  actorId: string,
  operation: string,
  key: string,
  body: unknown,
  statusCode: number,
  fn: (tx: Transaction) => Promise<T>,
): Promise<{ response: T; statusCode: number }> {
  const requestHash = createHash('sha256')
    .update(canonical(body))
    .digest('hex');
  return db.transaction(async (tx) => {
    // ON CONFLICT waits for a concurrent transaction's reservation to finish.
    await tx.execute(
      'INSERT INTO "IdempotencyRecord" (id,"actorId",operation,key,"requestHash") VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      randomUUID(),
      actorId,
      operation,
      key,
      requestHash,
    );
    const rows = await tx.query<{
      requestHash: string;
      response: T | null;
      statusCode: number | null;
    }>(
      'SELECT "requestHash",response,"statusCode" FROM "IdempotencyRecord" WHERE "actorId"=$1 AND operation=$2 AND key=$3 FOR UPDATE',
      actorId,
      operation,
      key,
    );
    const record = rows[0]!;
    if (record.requestHash !== requestHash)
      throw new ConflictException(
        'Idempotency key reused with a different request',
      );
    if (record.statusCode !== null)
      return { response: record.response as T, statusCode: record.statusCode };
    const response = await fn(tx);
    await tx.execute(
      'UPDATE "IdempotencyRecord" SET response=$1::jsonb,"statusCode"=$2 WHERE "actorId"=$3 AND operation=$4 AND key=$5',
      JSON.stringify(response),
      statusCode,
      actorId,
      operation,
      key,
    );
    return { response, statusCode };
  });
}
