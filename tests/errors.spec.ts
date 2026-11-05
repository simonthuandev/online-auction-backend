import { describe, expect, it } from 'vitest';
import {
  HttpException,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client/auth/index.js';
import type { Request, Response } from 'express';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { sendError } from '../libs/common/src/platform/http.js';
import { loadEnv } from '../scripts/platform/env.mjs';

const integration = process.env.PLATFORM_INTEGRATION === 'true';
if (integration) loadEnv();

interface MockResponse {
  statusCode: number;
  body: Record<string, unknown>;
  status: (code: number) => MockResponse;
  json: (data: Record<string, unknown>) => MockResponse;
}

function createMockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function createMockReq(requestId?: string): Request {
  return {
    requestId: requestId || randomUUID(),
  } as unknown as Request;
}

describe('PLAT-02: Database error to HTTP mapping (Unit Tests)', () => {
  it('maps Prisma P2002 to 409 CONFLICT without leaking constraint details', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`email`)',
      {
        code: 'P2002',
        clientVersion: '6.4.1',
        meta: { target: ['email'] },
      },
    );
    const req = createMockReq('req-p2002');
    const res = createMockRes();

    sendError(error, req, res as unknown as Response);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'CONFLICT',
      message: 'Resource already exists',
      requestId: 'req-p2002',
    });
    expect(JSON.stringify(res.body)).not.toContain('email');
  });

  it('maps Prisma P2010 with Postgres 23505 (unique violation) to 409 CONFLICT', () => {
    const error = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `23505`. Message: `duplicate key value violates unique constraint "Auction_one_open_per_product"`',
      {
        code: 'P2010',
        clientVersion: '6.4.1',
        meta: {
          code: '23505',
          message: 'duplicate key value violates unique constraint "Auction_one_open_per_product"',
        },
      },
    );
    const req = createMockReq('req-p2010-23505');
    const res = createMockRes();

    sendError(error, req, res as unknown as Response);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'CONFLICT',
      message: 'Resource already exists',
      requestId: 'req-p2010-23505',
    });
    expect(JSON.stringify(res.body)).not.toContain('Auction_one_open_per_product');
  });

  it('maps raw PostgreSQL driver 23505 to 409 CONFLICT', () => {
    const error = new Error('duplicate key value violates unique constraint "users_email_key"');
    (error as unknown as { code: string }).code = '23505';
    (error as unknown as { constraint: string }).constraint = 'users_email_key';

    const req = createMockReq('req-pg-23505');
    const res = createMockRes();

    sendError(error, req, res as unknown as Response);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'CONFLICT',
      message: 'Resource already exists',
      requestId: 'req-pg-23505',
    });
    expect(JSON.stringify(res.body)).not.toContain('users_email_key');
  });

  it('maps Postgres 23514 (CHECK constraint) to 400 INVALID_REQUEST', () => {
    const rawPgError = new Error('new row for relation "Auction" violates check constraint "Auction_startingPrice_check"');
    (rawPgError as unknown as { code: string }).code = '23514';

    const req1 = createMockReq('req-check-1');
    const res1 = createMockRes();
    sendError(rawPgError, req1, res1 as unknown as Response);

    expect(res1.statusCode).toBe(400);
    expect(res1.body).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Invalid request',
      requestId: 'req-check-1',
    });
    expect(JSON.stringify(res1.body)).not.toContain('Auction_startingPrice_check');

    // Also verify via Prisma P2010 with meta.code = '23514'
    const prismaCheckError = new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: 'P2010',
      clientVersion: '6.4.1',
      meta: { code: '23514' },
    });
    const req2 = createMockReq('req-check-2');
    const res2 = createMockRes();
    sendError(prismaCheckError, req2, res2 as unknown as Response);

    expect(res2.statusCode).toBe(400);
    expect(res2.body).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Invalid request',
      requestId: 'req-check-2',
    });
  });

  it('maps Prisma P2003 and Postgres 23503 (Foreign Key constraint) to 409 CONFLICT', () => {
    const prismaFk = new Prisma.PrismaClientKnownRequestError(
      'Foreign key constraint failed on the field: (`auctionId`)',
      {
        code: 'P2003',
        clientVersion: '6.4.1',
        meta: { field_name: 'auctionId' },
      },
    );
    const req1 = createMockReq('req-fk-1');
    const res1 = createMockRes();
    sendError(prismaFk, req1, res1 as unknown as Response);

    expect(res1.statusCode).toBe(409);
    expect(res1.body).toEqual({
      code: 'CONFLICT',
      message: 'Resource conflict',
      requestId: 'req-fk-1',
    });
    expect(JSON.stringify(res1.body)).not.toContain('auctionId');

    const pgFk = new Error('insert or update on table "Bid" violates foreign key constraint "Bid_auctionId_fkey"');
    (pgFk as unknown as { code: string }).code = '23503';
    const req2 = createMockReq('req-fk-2');
    const res2 = createMockRes();
    sendError(pgFk, req2, res2 as unknown as Response);

    expect(res2.statusCode).toBe(409);
    expect(res2.body).toEqual({
      code: 'CONFLICT',
      message: 'Resource conflict',
      requestId: 'req-fk-2',
    });
  });

  it('maps Prisma P2025 (record not found) to 404 NOT_FOUND', () => {
    const prismaNotFound = new Prisma.PrismaClientKnownRequestError(
      'An operation failed because it depends on one or more records that were required but not found. Record to update not found.',
      {
        code: 'P2025',
        clientVersion: '6.4.1',
      },
    );
    const req = createMockReq('req-p2025');
    const res = createMockRes();
    sendError(prismaNotFound, req, res as unknown as Response);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Resource not found',
      requestId: 'req-p2025',
    });
  });

  it('preserves existing HttpExceptions and custom error messages', () => {
    const badReq = new BadRequestException('Custom validation error');
    const res1 = createMockRes();
    sendError(badReq, createMockReq('req-http-1'), res1 as unknown as Response);
    expect(res1.statusCode).toBe(400);
    expect(res1.body).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Custom validation error',
      requestId: 'req-http-1',
    });

    const notFound = new NotFoundException('Item does not exist');
    const res2 = createMockRes();
    sendError(notFound, createMockReq('req-http-2'), res2 as unknown as Response);
    expect(res2.statusCode).toBe(404);
    expect(res2.body).toEqual({
      code: 'NOT_FOUND',
      message: 'Item does not exist',
      requestId: 'req-http-2',
    });

    const conflict = new ConflictException('Already claimed');
    const res3 = createMockRes();
    sendError(conflict, createMockReq('req-http-3'), res3 as unknown as Response);
    expect(res3.statusCode).toBe(409);
    expect(res3.body).toEqual({
      code: 'CONFLICT',
      message: 'Already claimed',
      requestId: 'req-http-3',
    });
  });

  it('handles unknown 500 errors safely without leaking internal stack traces', () => {
    const internalErr = new Error('Database connection failed: FATAL password authentication failed');
    const res = createMockRes();
    sendError(internalErr, createMockReq('req-500'), res as unknown as Response);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      requestId: 'req-500',
    });
    expect(JSON.stringify(res.body)).not.toContain('password');
  });
});

describe.skipIf(!integration)('PLAT-02: Integration verification for Auction_one_open_per_product', () => {
  it('violates Auction_one_open_per_product partial unique index and sends 409 CONFLICT', async () => {
    const client = new pg.Client({
      connectionString: process.env.AUCTION_DATABASE_URL,
    });
    await client.connect();

    const productId = randomUUID();
    const sellerId = randomUUID();
    const auctionId1 = randomUUID();
    const auctionId2 = randomUUID();

    try {
      await client.query('BEGIN');

      // Insert first open auction (status = 'INITIALIZING')
      await client.query(
        `INSERT INTO "Auction" (id, "productId", "sellerId", "startingPrice", "currentPrice", "bidIncrement", currency, "startTime", "endTime", status, "initializationRequest", "updatedAt")
         VALUES ($1, $2, $3, 100000, 100000, 10000, 'VND', now(), now() + interval '1 day', 'INITIALIZING', '{}'::jsonb, now())`,
        [auctionId1, productId, sellerId],
      );

      // Attempt to insert second open auction for the same product -> must violate partial unique index
      let caughtError: unknown;
      try {
        await client.query(
          `INSERT INTO "Auction" (id, "productId", "sellerId", "startingPrice", "currentPrice", "bidIncrement", currency, "startTime", "endTime", status, "initializationRequest", "updatedAt")
           VALUES ($1, $2, $3, 200000, 200000, 10000, 'VND', now(), now() + interval '1 day', 'INITIALIZING', '{}'::jsonb, now())`,
          [auctionId2, productId, sellerId],
        );
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const dbErr = caughtError as { code: string; constraint?: string };
      expect(dbErr.code).toBe('23505');
      expect(dbErr.constraint).toBe('Auction_one_open_per_product');

      // Verify that sendError transforms this real PostgreSQL error into a clean 409 envelope
      const req = createMockReq('req-real-db-23505');
      const res = createMockRes();
      sendError(caughtError, req, res as unknown as Response);

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({
        code: 'CONFLICT',
        message: 'Resource already exists',
        requestId: 'req-real-db-23505',
      });
      expect(JSON.stringify(res.body)).not.toContain('Auction_one_open_per_product');
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
