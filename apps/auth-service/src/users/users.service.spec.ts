import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ServiceHandlers } from '../service-handlers.js';
import { HttpHandlers, EventHandlers } from '../../../../libs/common/src/index.js';

describe('UsersService (Unit Tests)', () => {
  let service: UsersService;
  let mockPrisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
    };
  };

  const sampleDbUser = {
    id: '10000000-0000-4000-8000-000000000001',
    email: 'test@auction.test',
    password: '$2a$10$hashedpasswordstring',
    googleId: 'google-oauth-sub-12345',
    name: 'Test User',
    avatarUrl: 'https://example.com/avatar.png',
    role: 'USER' as const,
    provider: 'LOCAL' as const,
    isActive: true,
    isEmailVerified: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  };

  beforeEach(() => {
    mockPrisma = {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
      },
    };
    service = new UsersService(mockPrisma as unknown as PrismaService);
  });

  describe('getProfile', () => {
    it('returns public profile and strips sensitive fields', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(sampleDbUser);

      const result = await service.getProfile(sampleDbUser.id);

      expect(result).toEqual({
        id: sampleDbUser.id,
        email: 'test@auction.test',
        name: 'Test User',
        role: 'USER',
        avatarUrl: 'https://example.com/avatar.png',
        isActive: true,
      });

      // Verify sensitive fields are not in the response
      expect((result as Record<string, unknown>).password).toBeUndefined();
      expect((result as Record<string, unknown>).googleId).toBeUndefined();
      expect((result as Record<string, unknown>).provider).toBeUndefined();
    });

    it('throws 401 UnauthorizedException if user is inactive', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...sampleDbUser,
        isActive: false,
      });

      await expect(service.getProfile(sampleDbUser.id)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws 401 UnauthorizedException if user does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getProfile('non-existent-id')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('updateProfile', () => {
    it('updates name and avatarUrl successfully', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(sampleDbUser);
      mockPrisma.user.update.mockResolvedValue({
        ...sampleDbUser,
        name: 'New Name',
        avatarUrl: 'https://newdomain.com/avatar.jpg',
      });

      const result = await service.updateProfile(sampleDbUser.id, {
        name: 'New Name',
        avatarUrl: 'https://newdomain.com/avatar.jpg',
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: sampleDbUser.id },
        data: {
          name: 'New Name',
          avatarUrl: 'https://newdomain.com/avatar.jpg',
        },
      });

      expect(result).toEqual({
        id: sampleDbUser.id,
        email: 'test@auction.test',
        name: 'New Name',
        role: 'USER',
        avatarUrl: 'https://newdomain.com/avatar.jpg',
        isActive: true,
      });
      expect((result as Record<string, unknown>).password).toBeUndefined();
    });

    it('allows setting avatarUrl to null', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(sampleDbUser);
      mockPrisma.user.update.mockResolvedValue({
        ...sampleDbUser,
        avatarUrl: null,
      });

      const result = await service.updateProfile(sampleDbUser.id, {
        avatarUrl: null,
      });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: sampleDbUser.id },
        data: { avatarUrl: null },
      });
      expect(result.avatarUrl).toBeNull();
    });

    it('throws 400 BadRequestException if request body is empty', async () => {
      await expect(
        service.updateProfile(sampleDbUser.id, {} as unknown as { name?: string }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateProfile(sampleDbUser.id, null as unknown as { name?: string }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 BadRequestException if name is empty or only whitespace', async () => {
      await expect(
        service.updateProfile(sampleDbUser.id, { name: '' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateProfile(sampleDbUser.id, { name: '   ' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 BadRequestException if name exceeds 100 characters', async () => {
      const longName = 'A'.repeat(101);
      await expect(
        service.updateProfile(sampleDbUser.id, { name: longName }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 BadRequestException if avatarUrl exceeds 2048 characters', async () => {
      const longUrl = 'https://example.com/' + 'x'.repeat(2040);
      await expect(
        service.updateProfile(sampleDbUser.id, { avatarUrl: longUrl }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 400 BadRequestException if avatarUrl is not a valid http/https URL', async () => {
      await expect(
        service.updateProfile(sampleDbUser.id, {
          avatarUrl: 'javascript:alert(1)',
        }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateProfile(sampleDbUser.id, { avatarUrl: 'ftp://files/a.png' }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.updateProfile(sampleDbUser.id, { avatarUrl: 'not-a-url' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws 401 UnauthorizedException if user to update is inactive', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        ...sampleDbUser,
        isActive: false,
      });

      await expect(
        service.updateProfile(sampleDbUser.id, { name: 'Updated' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws 401 UnauthorizedException if user to update does not exist', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProfile('unknown-id', { name: 'Updated' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('ServiceHandlers integration', () => {
    it('registers both GET and PATCH operations and delegates with principal.sub', async () => {
      const http = new HttpHandlers();
      const events = new EventHandlers();
      const handlers = new ServiceHandlers(http, events, service);

      mockPrisma.user.findUnique.mockResolvedValue(sampleDbUser);
      mockPrisma.user.update.mockResolvedValue({
        ...sampleDbUser,
        name: 'Handled Name',
      });

      handlers.onModuleInit();

      const getHandler = http.get('auth_get__api_auth_me');
      const patchHandler = http.get('auth_patch__api_auth_me');

      expect(getHandler).toBeDefined();
      expect(patchHandler).toBeDefined();

      // GET calls
      const getRes = await getHandler!({
        principal: { sub: sampleDbUser.id, role: 'USER', type: 'access' },
      } as unknown as Parameters<typeof getHandler>[0]);
      expect(getRes).toEqual(expect.objectContaining({ name: 'Test User' }));

      // Missing principal throws 401
      await expect(
        getHandler!({} as unknown as Parameters<typeof getHandler>[0]),
      ).rejects.toThrow(UnauthorizedException);

      // PATCH calls
      const patchRes = await patchHandler!({
        principal: { sub: sampleDbUser.id, role: 'USER', type: 'access' },
        body: { name: 'Handled Name' },
      } as unknown as Parameters<typeof patchHandler>[0]);
      expect(patchRes).toEqual(expect.objectContaining({ name: 'Handled Name' }));

      // Missing principal on PATCH throws 401
      await expect(
        patchHandler!({
          body: { name: 'Handled Name' },
        } as unknown as Parameters<typeof patchHandler>[0]),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
