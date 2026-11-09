import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  NotificationRecord,
  NotificationRepository,
} from './notification.repository.js';
import { NotificationService } from './notification.service.js';

describe('NotificationService (Unit Tests)', () => {
  const repository = {
    findMany: vi.fn(),
    markAsRead: vi.fn(),
  };

  const service = new NotificationService(
    repository as unknown as NotificationRepository,
  );

  const userA = '10000000-0000-4000-8000-000000000001';
  const userB = '20000000-0000-4000-8000-000000000002';

  const sampleNotification: NotificationRecord = {
    id: '30000000-0000-4000-8000-000000000001',
    userId: userA,
    sourceEventId: 'event-uuid-1',
    title: 'You were outbid!',
    message: 'A higher bid was placed on Antique Clock',
    type: 'OUTBID',
    isRead: false,
    metadata: { auctionId: 'auction-123', currentPrice: '150000' },
    createdAt: new Date('2026-11-09T10:00:00.000Z'),
  };

  const sampleNotificationRead: NotificationRecord = {
    ...sampleNotification,
    id: '30000000-0000-4000-8000-000000000002',
    isRead: true,
    title: 'Auction Won',
    type: 'AUCTION_WON',
    createdAt: new Date('2026-11-09T09:00:00.000Z'),
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('GET List Notifications', () => {
    it('throws ForbiddenException when userId is undefined', async () => {
      await expect(service.list(undefined, {})).rejects.toThrow(
        ForbiddenException,
      );
      expect(repository.findMany).not.toHaveBeenCalled();
    });

    it('queries notifications strictly for the caller recipient (userA)', async () => {
      repository.findMany.mockResolvedValue({
        items: [sampleNotification, sampleNotificationRead],
        total: 2,
      });

      const result = await service.list(userA, {});

      expect(repository.findMany).toHaveBeenCalledWith(
        1,
        20,
        expect.objectContaining({
          userId: userA,
        }),
      );

      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);

      // Verify mapped response fields and no internal sourceEventId leaked
      expect(result.items[0]).toEqual({
        id: sampleNotification.id,
        userId: userA,
        title: sampleNotification.title,
        message: sampleNotification.message,
        type: 'OUTBID',
        isRead: false,
        metadata: { auctionId: 'auction-123', currentPrice: '150000' },
        createdAt: '2026-11-09T10:00:00.000Z',
      });
      expect(result.items[0]).not.toHaveProperty('sourceEventId');
    });

    it('orders by createdAt desc and handles pagination parameters', async () => {
      repository.findMany.mockResolvedValue({
        items: [sampleNotificationRead],
        total: 15,
      });

      const result = await service.list(userA, { page: '2', pageSize: '10' });

      expect(repository.findMany).toHaveBeenCalledWith(
        2,
        10,
        expect.objectContaining({
          userId: userA,
        }),
      );
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(result.total).toBe(15);
    });

    it('filters by status = UNREAD (isRead = false)', async () => {
      repository.findMany.mockResolvedValue({
        items: [sampleNotification],
        total: 1,
      });

      await service.list(userA, { status: 'UNREAD' });

      expect(repository.findMany).toHaveBeenCalledWith(1, 20, {
        userId: userA,
        isRead: false,
        search: undefined,
      });
    });

    it('filters by status = READ (isRead = true)', async () => {
      repository.findMany.mockResolvedValue({
        items: [sampleNotificationRead],
        total: 1,
      });

      await service.list(userA, { status: 'READ' });

      expect(repository.findMany).toHaveBeenCalledWith(1, 20, {
        userId: userA,
        isRead: true,
        search: undefined,
      });
    });

    it('passes search filter when provided', async () => {
      repository.findMany.mockResolvedValue({
        items: [sampleNotification],
        total: 1,
      });

      await service.list(userA, { search: 'Clock' });

      expect(repository.findMany).toHaveBeenCalledWith(1, 20, {
        userId: userA,
        isRead: undefined,
        search: 'Clock',
      });
    });

    it('throws BadRequestException (400) when status filter value is invalid', async () => {
      await expect(service.list(userA, { status: 'PENDING' })).rejects.toThrow(
        BadRequestException,
      );

      await expect(service.list(userA, { status: 'unread' })).rejects.toThrow(
        BadRequestException,
      );

      expect(repository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('PATCH Mark As Read', () => {
    it('throws ForbiddenException when userId is undefined', async () => {
      await expect(
        service.markAsRead(sampleNotification.id, undefined),
      ).rejects.toThrow(ForbiddenException);
      expect(repository.markAsRead).not.toHaveBeenCalled();
    });

    it('marks unread notification as read successfully and returns 200', async () => {
      repository.markAsRead.mockResolvedValue({
        ...sampleNotification,
        isRead: true,
      });

      const result = await service.markAsRead(sampleNotification.id, userA);

      expect(repository.markAsRead).toHaveBeenCalledWith(
        sampleNotification.id,
        userA,
      );
      expect(result).toEqual({
        id: sampleNotification.id,
        userId: userA,
        title: sampleNotification.title,
        message: sampleNotification.message,
        type: 'OUTBID',
        isRead: true,
        metadata: { auctionId: 'auction-123', currentPrice: '150000' },
        createdAt: '2026-11-09T10:00:00.000Z',
      });
      expect(result).not.toHaveProperty('sourceEventId');
    });

    it('is idempotent: calling markAsRead on an already-read notification returns 200 with current state', async () => {
      repository.markAsRead.mockResolvedValue(sampleNotificationRead);

      const result = await service.markAsRead(sampleNotificationRead.id, userA);

      expect(repository.markAsRead).toHaveBeenCalledWith(
        sampleNotificationRead.id,
        userA,
      );
      expect(result.id).toBe(sampleNotificationRead.id);
      expect(result.isRead).toBe(true);
    });

    it('returns 404 NotFoundException when notification belongs to another user (userB)', async () => {
      // Repository scoped by both id AND userId returns null when notification belongs to userB
      repository.markAsRead.mockResolvedValue(null);

      await expect(
        service.markAsRead(sampleNotification.id, userB),
      ).rejects.toThrow(NotFoundException);

      expect(repository.markAsRead).toHaveBeenCalledWith(
        sampleNotification.id,
        userB,
      );
    });

    it('returns 404 NotFoundException when notification does not exist', async () => {
      repository.markAsRead.mockResolvedValue(null);

      await expect(
        service.markAsRead('non-existent-uuid', userA),
      ).rejects.toThrow(NotFoundException);

      expect(repository.markAsRead).toHaveBeenCalledWith(
        'non-existent-uuid',
        userA,
      );
    });
  });
});
