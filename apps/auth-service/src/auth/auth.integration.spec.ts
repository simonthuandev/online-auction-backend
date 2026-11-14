import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { loadEnv } from '../../../../scripts/platform/env.mjs';
import { integrationEnabled } from '../../../../tests/support/pg-database.js';

if (integrationEnabled) loadEnv();

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe.skipIf(!integrationEnabled)('Auth Service Integration (PostgreSQL)', () => {
  let pool: pg.Pool;
  let prisma: PrismaService;
  let authService: AuthService;
  let jwtService: JwtService;

  const createdUserIds: string[] = [];

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env.AUTH_DATABASE_URL,
      max: 10,
    });
    prisma = new PrismaService();
    await prisma.$connect();
    authService = new AuthService(prisma);
    jwtService = new JwtService();
  });

  afterAll(async () => {
    try {
      if (createdUserIds.length > 0) {
        await pool.query(
          'DELETE FROM "RefreshToken" WHERE "userId" = ANY($1::text[])',
          [createdUserIds],
        );
        await pool.query('DELETE FROM "User" WHERE id = ANY($1::text[])', [
          createdUserIds,
        ]);
      }
    } finally {
      await prisma.$disconnect();
      await pool.end();
    }
  });

  async function createTestUser(overrides?: {
    isActive?: boolean;
    role?: 'USER' | 'SELLER' | 'ADMIN';
  }) {
    const id = randomUUID();
    const email = `test-auth-${id.slice(0, 8)}-${Date.now()}@auction.test`;
    const password = 'Password123!';
    const user = await authService.register({
      email,
      password,
      name: `User ${id.slice(0, 8)}`,
    });
    createdUserIds.push(user.id);

    if (overrides?.isActive === false) {
      await pool.query('UPDATE "User" SET "isActive" = false WHERE id = $1', [
        user.id,
      ]);
    }
    if (overrides?.role) {
      await pool.query(
        'UPDATE "User" SET role = $1::"UserRole" WHERE id = $2',
        [overrides.role, user.id],
      );
    }
    return { id: user.id, email, password };
  }

  describe('Refresh Token Rotation', () => {
    it('rotates refresh token on each call and maintains familyId', async () => {
      const user = await createTestUser();
      const loginRes = await authService.login({
        email: user.email,
        password: user.password,
      });

      const rt1 = loginRes.refreshToken;
      const rt1Hash = hash(rt1);

      // Verify RT1 is stored in DB with isRevoked = false
      const { rows: rt1Rows } = await pool.query<{
        familyId: string;
        isRevoked: boolean;
      }>(
        'SELECT "familyId", "isRevoked" FROM "RefreshToken" WHERE "tokenHash" = $1',
        [rt1Hash],
      );
      expect(rt1Rows).toHaveLength(1);
      expect(rt1Rows[0].isRevoked).toBe(false);
      const familyId = rt1Rows[0].familyId;

      // First rotation: RT1 -> RT2
      const refreshRes1 = await authService.refresh(rt1);
      const rt2 = refreshRes1.refreshToken;
      const rt2Hash = hash(rt2);

      expect(rt2).not.toBe(rt1);

      // Verify in DB: RT1 is revoked, RT2 is active with same familyId
      const { rows: rowsAfter1 } = await pool.query<{
        tokenHash: string;
        familyId: string;
        isRevoked: boolean;
      }>(
        'SELECT "tokenHash", "familyId", "isRevoked" FROM "RefreshToken" WHERE "tokenHash" = ANY($1::text[])',
        [[rt1Hash, rt2Hash]],
      );
      expect(rowsAfter1).toHaveLength(2);
      const rt1After = rowsAfter1.find((r) => r.tokenHash === rt1Hash);
      const rt2After = rowsAfter1.find((r) => r.tokenHash === rt2Hash);
      expect(rt1After?.isRevoked).toBe(true);
      expect(rt2After?.isRevoked).toBe(false);
      expect(rt2After?.familyId).toBe(familyId);

      // Second rotation: RT2 -> RT3
      const refreshRes2 = await authService.refresh(rt2);
      const rt3 = refreshRes2.refreshToken;
      const rt3Hash = hash(rt3);

      expect(rt3).not.toBe(rt2);

      // Verify in DB: RT2 is revoked, RT3 is active with same familyId
      const { rows: rowsAfter2 } = await pool.query<{
        tokenHash: string;
        familyId: string;
        isRevoked: boolean;
      }>(
        'SELECT "tokenHash", "familyId", "isRevoked" FROM "RefreshToken" WHERE "tokenHash" = ANY($1::text[])',
        [[rt1Hash, rt2Hash, rt3Hash]],
      );
      expect(rowsAfter2).toHaveLength(3);
      expect(
        rowsAfter2.find((r) => r.tokenHash === rt1Hash)?.isRevoked,
      ).toBe(true);
      expect(
        rowsAfter2.find((r) => r.tokenHash === rt2Hash)?.isRevoked,
      ).toBe(true);
      const rt3Db = rowsAfter2.find((r) => r.tokenHash === rt3Hash);
      expect(rt3Db?.isRevoked).toBe(false);
      expect(rt3Db?.familyId).toBe(familyId);
    });
  });

  describe('Reuse Detection & Family Revocation (RFC 6819)', () => {
    it('revokes the entire family when an already rotated token is reused', async () => {
      const user = await createTestUser();
      const loginRes = await authService.login({
        email: user.email,
        password: user.password,
      });

      const rt1 = loginRes.refreshToken;

      // Legitimate client rotates RT1 -> RT2
      const refreshRes = await authService.refresh(rt1);
      const rt2 = refreshRes.refreshToken;

      // Attacker (or replayed client) tries to use the already rotated RT1
      await expect(authService.refresh(rt1)).rejects.toThrow(
        UnauthorizedException,
      );

      // Check DB: ALL tokens in the family must now be revoked
      const { rows: familyRows } = await pool.query<{
        tokenHash: string;
        isRevoked: boolean;
      }>(
        'SELECT "tokenHash", "isRevoked" FROM "RefreshToken" WHERE "userId" = $1',
        [user.id],
      );
      expect(familyRows.length).toBeGreaterThanOrEqual(2);
      expect(familyRows.every((r) => r.isRevoked === true)).toBe(true);

      // Now the legitimate user tries to use RT2 -> should be REJECTED because family was revoked
      await expect(authService.refresh(rt2)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Logout & Family Revocation', () => {
    it('revokes all tokens in family upon logout and does not affect new logins', async () => {
      const user = await createTestUser();
      const loginRes = await authService.login({
        email: user.email,
        password: user.password,
      });

      const rt1 = loginRes.refreshToken;
      // Rotate RT1 -> RT2
      const refreshRes = await authService.refresh(rt1);
      const rt2 = refreshRes.refreshToken;

      // User logs out using RT2
      const logoutRes = await authService.logout(rt2);
      expect(logoutRes).toEqual({ revoked: true });

      // In DB: both RT1 and RT2 must be revoked
      const { rows: family1Rows } = await pool.query<{
        tokenHash: string;
        isRevoked: boolean;
        familyId: string;
      }>(
        'SELECT "tokenHash", "isRevoked", "familyId" FROM "RefreshToken" WHERE "userId" = $1',
        [user.id],
      );
      expect(family1Rows.every((r) => r.isRevoked === true)).toBe(true);
      const firstFamilyId = family1Rows[0].familyId;

      // Subsequent refresh with RT2 fails
      await expect(authService.refresh(rt2)).rejects.toThrow(
        UnauthorizedException,
      );

      // User logs in again -> creates a NEW family
      const loginRes2 = await authService.login({
        email: user.email,
        password: user.password,
      });
      const rt3 = loginRes2.refreshToken;

      const { rows: rt3Rows } = await pool.query<{
        familyId: string;
        isRevoked: boolean;
      }>(
        'SELECT "familyId", "isRevoked" FROM "RefreshToken" WHERE "tokenHash" = $1',
        [hash(rt3)],
      );
      expect(rt3Rows[0].isRevoked).toBe(false);
      expect(rt3Rows[0].familyId).not.toBe(firstFamilyId);

      // RT3 refreshes successfully
      const refreshRes2 = await authService.refresh(rt3);
      expect(refreshRes2).toHaveProperty('accessToken');
      expect(refreshRes2).toHaveProperty('refreshToken');
    });
  });

  describe('Concurrent Refresh Requests (Race Condition & Row Locking)', () => {
    it('allows only one request to succeed when two identical refresh calls run concurrently', async () => {
      const user = await createTestUser();
      const loginRes = await authService.login({
        email: user.email,
        password: user.password,
      });

      const token = loginRes.refreshToken;

      // Launch two concurrent refresh requests with the exact same token
      const [res1, res2] = await Promise.allSettled([
        authService.refresh(token),
        authService.refresh(token),
      ]);

      const succeeded = [res1, res2].filter((r) => r.status === 'fulfilled');
      const failed = [res1, res2].filter((r) => r.status === 'rejected');

      // Exactly ONE must succeed and ONE must fail
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);

      // The failed request must be an UnauthorizedException
      const failureReason = (
        failed[0] as PromiseRejectedResult
      ).reason as Error;
      expect(failureReason).toBeInstanceOf(UnauthorizedException);

      // Verify DB state: exactly 2 tokens recorded (initial + 1 rotated)
      const { rows: tokens } = await pool.query<{
        tokenHash: string;
        isRevoked: boolean;
      }>(
        'SELECT "tokenHash", "isRevoked" FROM "RefreshToken" WHERE "userId" = $1',
        [user.id],
      );
      expect(tokens).toHaveLength(2);

      // The initial token must be revoked
      const initialTokenDb = tokens.find((t) => t.tokenHash === hash(token));
      expect(initialTokenDb?.isRevoked).toBe(true);
    });
  });

  describe('Expired Tokens', () => {
    it('rejects an expired JWT token at verification level', async () => {
      const user = await createTestUser();

      // Sign an expired refresh token directly
      const expiredJwt = jwtService.sign(
        { sub: user.id, type: 'refresh' },
        {
          secret: process.env.JWT_REFRESH_SECRET,
          algorithm: 'HS256',
          issuer: process.env.JWT_ISSUER,
          audience: 'online-auction-refresh',
          expiresIn: '-1s',
          jwtid: randomUUID(),
        },
      );

      await expect(authService.refresh(expiredJwt)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a valid JWT when its database record has expired (expiresAt <= now)', async () => {
      const user = await createTestUser();
      const loginRes = await authService.login({
        email: user.email,
        password: user.password,
      });

      const token = loginRes.refreshToken;

      // Manually backdate expiresAt in DB to 1 hour ago
      await pool.query(
        `UPDATE "RefreshToken"
         SET "expiresAt" = timezone('UTC', now()) - interval '1 hour'
         WHERE "tokenHash" = $1`,
        [hash(token)],
      );

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('Locked / Inactive Users (isActive = false)', () => {
    it('prevents login when user is deactivated', async () => {
      const user = await createTestUser({ isActive: false });

      await expect(
        authService.login({
          email: user.email,
          password: user.password,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('prevents refresh when active user is locked after receiving tokens', async () => {
      const user = await createTestUser({ isActive: true });
      const loginRes = await authService.login({
        email: user.email,
        password: user.password,
      });

      const token = loginRes.refreshToken;

      // Deactivate user in DB
      await pool.query('UPDATE "User" SET "isActive" = false WHERE id = $1', [
        user.id,
      ]);

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
