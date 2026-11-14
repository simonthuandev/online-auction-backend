import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { User, RefreshToken, Prisma } from '@prisma/client/auth/index.js';

// Ensure required environment variables for JWT are defined
process.env.JWT_PRIVATE_KEY_PATH =
  process.env.JWT_PRIVATE_KEY_PATH || '.local/keys/private.pem';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-min-32-chars-long!!';
process.env.JWT_ISSUER =
  process.env.JWT_ISSUER || 'https://auth.auction.local';
process.env.JWT_AUDIENCE =
  process.env.JWT_AUDIENCE || 'online-auction-api';
process.env.JWT_KEY_ID = process.env.JWT_KEY_ID || 'dev-key-1';

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');

describe('AuthService & AuthController (Unit Tests)', () => {
  let authService: AuthService;
  let authController: AuthController;
  let jwtService: JwtService;

  let mockPrisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
    refreshToken: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    $transaction: ReturnType<typeof vi.fn>;
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  const sampleUser: User = {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'bidder@auction.test',
    password: '$2a$10$hashedpasswordstring',
    googleId: null,
    name: 'Bidder One',
    avatarUrl: null,
    role: 'USER',
    provider: 'LOCAL',
    isActive: true,
    isEmailVerified: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  function createValidRefreshToken(overrides?: {
    secret?: string;
    algorithm?: 'HS256' | 'HS384' | 'HS512';
    issuer?: string;
    audience?: string;
    expiresIn?: string | number;
    sub?: string;
    jti?: string;
    type?: string;
    omitJti?: boolean;
    omitSub?: boolean;
  }): string {
    const secret = overrides?.secret ?? process.env.JWT_REFRESH_SECRET!;
    const payload: Record<string, unknown> = {};

    if (!overrides?.omitSub) {
      payload.sub =
        overrides?.sub !== undefined ? overrides.sub : sampleUser.id;
    }
    if (overrides?.type !== undefined) {
      payload.type = overrides.type;
    } else {
      payload.type = 'refresh';
    }

    const signOptions: Record<string, unknown> = {
      secret,
      algorithm: overrides?.algorithm ?? 'HS256',
      issuer:
        overrides?.issuer !== undefined
          ? overrides.issuer
          : process.env.JWT_ISSUER!,
      audience:
        overrides?.audience !== undefined
          ? overrides.audience
          : 'online-auction-refresh',
      expiresIn:
        overrides?.expiresIn !== undefined ? overrides.expiresIn : '7d',
    };

    if (!overrides?.omitJti) {
      signOptions.jwtid =
        overrides?.jti !== undefined ? overrides.jti : randomUUID();
    }

    return jwtService.sign(payload, signOptions);
  }

  beforeEach(() => {
    jwtService = new JwtService();

    mockPrisma = {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      refreshToken: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (tx: Prisma.TransactionClient) => unknown) => {
        const fakeTx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          refreshToken: mockPrisma.refreshToken,
          user: mockPrisma.user,
        };
        return callback(fakeTx as unknown as Prisma.TransactionClient);
      }),
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    authService = new AuthService(mockPrisma as unknown as PrismaService);
    authController = new AuthController(authService);
  });

  describe('JWT Claims Validation (verifyRefresh)', () => {
    it('throws UnauthorizedException when token is not a valid JWT string', async () => {
      await expect(authService.refresh('invalid-token-string')).rejects.toThrow(
        UnauthorizedException,
      );
      await expect(authService.logout('invalid-token-string')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token is signed with wrong secret', async () => {
      const wrongSecretToken = createValidRefreshToken({
        secret: 'wrong-secret-key-that-does-not-match',
      });
      await expect(authService.refresh(wrongSecretToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token has wrong algorithm', async () => {
      const wrongAlgoToken = createValidRefreshToken({
        algorithm: 'HS384',
      });
      await expect(authService.refresh(wrongAlgoToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token has wrong issuer', async () => {
      const wrongIssuerToken = createValidRefreshToken({
        issuer: 'https://impostor-auth.test',
      });
      await expect(authService.refresh(wrongIssuerToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token has wrong audience', async () => {
      const wrongAudToken = createValidRefreshToken({
        audience: 'online-auction-api', // access token audience instead of refresh audience
      });
      await expect(authService.refresh(wrongAudToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token has wrong type claim', async () => {
      const accessTypeToken = createValidRefreshToken({
        type: 'access',
      });
      await expect(authService.refresh(accessTypeToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token lacks jti claim', async () => {
      const tokenWithoutJti = createValidRefreshToken({
        omitJti: true,
      });
      await expect(authService.refresh(tokenWithoutJti)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when token lacks sub claim', async () => {
      const tokenWithoutSub = createValidRefreshToken({
        omitSub: true,
      });
      await expect(authService.refresh(tokenWithoutSub)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException when JWT token is expired', async () => {
      const expiredToken = createValidRefreshToken({
        expiresIn: '-1s',
      });
      await expect(authService.refresh(expiredToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('register', () => {
    it('throws BadRequestException if password exceeds 72 UTF-8 bytes', async () => {
      const longPassword = 'a'.repeat(73);
      await expect(
        authService.register({
          email: 'test@auction.test',
          password: longPassword,
          name: 'Long Pass User',
        }),
      ).rejects.toThrow(BadRequestException);

      // Multibyte test (20 emojis = 80 bytes)
      const emojiPassword = '🔒'.repeat(20);
      await expect(
        authService.register({
          email: 'test@auction.test',
          password: emojiPassword,
          name: 'Emoji Pass User',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('hashes password with bcrypt and creates user with lowercase email', async () => {
      mockPrisma.user.create.mockResolvedValue(sampleUser);

      const result = await authService.register({
        email: 'BIDDER@Auction.Test',
        password: 'Password123!',
        name: 'Bidder One',
      });

      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: {
          email: 'bidder@auction.test',
          password: expect.any(String),
          name: 'Bidder One',
        },
      });

      const calledPassword = mockPrisma.user.create.mock.calls[0][0].data.password;
      expect(await bcrypt.compare('Password123!', calledPassword)).toBe(true);

      expect(result).toEqual({
        id: sampleUser.id,
        email: sampleUser.email,
        name: sampleUser.name,
        role: sampleUser.role,
        avatarUrl: sampleUser.avatarUrl,
        isActive: sampleUser.isActive,
      });
      expect((result as Record<string, unknown>).password).toBeUndefined();
    });
  });

  describe('login', () => {
    it('throws UnauthorizedException if user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        authService.login({
          email: 'nonexistent@auction.test',
          password: 'Password123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException if user has null password (OAuth-only user)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...sampleUser,
        password: null,
      });

      await expect(
        authService.login({
          email: sampleUser.email,
          password: 'Password123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException if user isActive is false', async () => {
      const hashedPassword = await bcrypt.hash('Password123!', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        ...sampleUser,
        password: hashedPassword,
        isActive: false,
      });

      await expect(
        authService.login({
          email: sampleUser.email,
          password: 'Password123!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException if password does not match', async () => {
      const hashedPassword = await bcrypt.hash('CorrectPassword123!', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        ...sampleUser,
        password: hashedPassword,
      });

      await expect(
        authService.login({
          email: sampleUser.email,
          password: 'WrongPassword!',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns accessToken and refreshToken pair on valid credentials', async () => {
      const hashedPassword = await bcrypt.hash('Password123!', 10);
      mockPrisma.user.findUnique.mockResolvedValue({
        ...sampleUser,
        password: hashedPassword,
      });
      mockPrisma.refreshToken.create.mockResolvedValue({} as RefreshToken);

      const result = await authService.login({
        email: sampleUser.email,
        password: 'Password123!',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');

      // Verify accessToken payload claims
      const accessPayload = jwtService.decode(result.accessToken) as Record<
        string,
        unknown
      >;
      expect(accessPayload.sub).toBe(sampleUser.id);
      expect(accessPayload.role).toBe(sampleUser.role);
      expect(accessPayload.type).toBe('access');

      // Verify refreshToken was stored in DB hashed
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tokenHash: hash(result.refreshToken),
          userId: sampleUser.id,
          familyId: expect.any(String),
        }),
      });
    });
  });

  describe('refresh', () => {
    it('throws UnauthorizedException if refresh token is not found in database', async () => {
      const token = createValidRefreshToken();
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException if token jti does not match database record', async () => {
      const token = createValidRefreshToken({ jti: 'jti-one' });
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-db-id',
        jti: 'jti-different',
        userId: sampleUser.id,
        familyId: 'family-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        user: sampleUser,
      });

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException if token sub does not match record userId', async () => {
      const token = createValidRefreshToken({ sub: sampleUser.id });
      const decoded = jwtService.decode(token) as { jti: string };
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-db-id',
        jti: decoded.jti,
        userId: 'different-user-id',
        familyId: 'family-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        user: sampleUser,
      });

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException if database token record is expired (expiresAt <= now)', async () => {
      const token = createValidRefreshToken();
      const decoded = jwtService.decode(token) as { jti: string };
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-db-id',
        jti: decoded.jti,
        userId: sampleUser.id,
        familyId: 'family-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() - 1000), // Expired 1 second ago
        user: sampleUser,
      });

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException if user isActive is false at refresh time', async () => {
      const token = createValidRefreshToken();
      const decoded = jwtService.decode(token) as { jti: string };
      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-db-id',
        jti: decoded.jti,
        userId: sampleUser.id,
        familyId: 'family-1',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        user: { ...sampleUser, isActive: false },
      });

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('triggers family revocation and throws UnauthorizedException when token is already revoked (reuse detection)', async () => {
      const token = createValidRefreshToken();
      const decoded = jwtService.decode(token) as { jti: string };
      const familyId = 'family-compromised-123';

      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-db-id',
        tokenHash: hash(token),
        jti: decoded.jti,
        userId: sampleUser.id,
        familyId,
        isRevoked: true, // Already revoked!
        expiresAt: new Date(Date.now() + 86400000),
        user: sampleUser,
      });

      await expect(authService.refresh(token)).rejects.toThrow(
        UnauthorizedException,
      );

      // Verify entire family was revoked in DB
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId },
        data: { isRevoked: true },
      });
    });

    it('rotates token successfully: marks old token revoked and issues new pair in same family', async () => {
      const token = createValidRefreshToken();
      const decoded = jwtService.decode(token) as { jti: string };
      const familyId = 'family-legit-456';

      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-db-id',
        tokenHash: hash(token),
        jti: decoded.jti,
        userId: sampleUser.id,
        familyId,
        isRevoked: false,
        expiresAt: new Date(Date.now() + 86400000),
        user: sampleUser,
      });
      mockPrisma.refreshToken.update.mockResolvedValue({} as RefreshToken);
      mockPrisma.refreshToken.create.mockResolvedValue({} as RefreshToken);

      const result = await authService.refresh(token);

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');

      // Verify old token was marked revoked
      expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: 'token-db-id' },
        data: { isRevoked: true },
      });

      // Verify new token was created in the SAME family
      expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          familyId,
          userId: sampleUser.id,
        }),
      });
    });
  });

  describe('logout', () => {
    it('revokes entire token family when valid refresh token is passed', async () => {
      const token = createValidRefreshToken();
      const familyId = 'family-logout-789';

      mockPrisma.refreshToken.findUnique.mockResolvedValue({
        id: 'token-db-id',
        familyId,
      });
      mockPrisma.refreshToken.updateMany.mockResolvedValue({ count: 2 });

      const result = await authService.logout(token);

      expect(result).toEqual({ revoked: true });
      expect(mockPrisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { familyId },
        data: { isRevoked: true },
      });
    });

    it('returns { revoked: true } without error if token record is not in database', async () => {
      const token = createValidRefreshToken();
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

      const result = await authService.logout(token);
      expect(result).toEqual({ revoked: true });
      expect(mockPrisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('AuthController delegation', () => {
    it('delegates register to authService.register', async () => {
      const registerSpy = vi
        .spyOn(authService, 'register')
        .mockResolvedValue(sampleUser);

      const body = {
        email: 'test@auction.test',
        password: 'Password123!',
        name: 'Test',
      };
      const result = await authController.register(body);

      expect(registerSpy).toHaveBeenCalledWith(body);
      expect(result).toEqual(sampleUser);
    });

    it('delegates login to authService.login', async () => {
      const loginSpy = vi.spyOn(authService, 'login').mockResolvedValue({
        accessToken: 'at-token',
        refreshToken: 'rt-token',
      });

      const body = { email: 'test@auction.test', password: 'Password123!' };
      const result = await authController.login(body);

      expect(loginSpy).toHaveBeenCalledWith(body);
      expect(result).toEqual({
        accessToken: 'at-token',
        refreshToken: 'rt-token',
      });
    });

    it('delegates refresh to authService.refresh', async () => {
      const refreshSpy = vi.spyOn(authService, 'refresh').mockResolvedValue({
        accessToken: 'new-at',
        refreshToken: 'new-rt',
      });

      const result = await authController.refresh('rt-token');

      expect(refreshSpy).toHaveBeenCalledWith('rt-token');
      expect(result).toEqual({ accessToken: 'new-at', refreshToken: 'new-rt' });
    });

    it('delegates logout to authService.logout', async () => {
      const logoutSpy = vi
        .spyOn(authService, 'logout')
        .mockResolvedValue({ revoked: true });

      const result = await authController.logout('rt-token');

      expect(logoutSpy).toHaveBeenCalledWith('rt-token');
      expect(result).toEqual({ revoked: true });
    });
  });
});
