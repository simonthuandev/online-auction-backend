import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandlers, HttpHandlers, IntegrationEvent, Transaction } from '@app/common';
import { ServiceHandlers } from '../service-handlers.js';
import { NotificationService } from './notification.service.js';
import { NotificationConsumer } from './consumers/notification.consumer.js';

type TestRequest = {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  principal?: { sub: string; role: string };
};

describe('Notification ServiceHandlers (HTTP & Events)', () => {
  const registeredHttp = new Map<
    string,
    (request: TestRequest) => Promise<unknown>
  >();

  const registeredEvents = new Map<
    string,
    (tx: Transaction, event: IntegrationEvent) => Promise<unknown>
  >();

  const http = {
    register: vi.fn(
      (
        operationId: string,
        handler: (request: TestRequest) => Promise<unknown>,
      ) => registeredHttp.set(operationId, handler),
    ),
  };

  const events = {
    register: vi.fn(
      (
        eventName: string,
        handler: (tx: Transaction, event: IntegrationEvent) => Promise<unknown>,
      ) => registeredEvents.set(eventName, handler),
    ),
  };

  const notifications = {
    list: vi.fn(),
    markAsRead: vi.fn(),
  };

  const consumer = {
    handleBidPlaced: vi.fn(),
    handleAuctionEnded: vi.fn(),
    handlePaymentSucceeded: vi.fn(),
  };

  beforeEach(() => {
    registeredHttp.clear();
    registeredEvents.clear();
    vi.clearAllMocks();
    new ServiceHandlers(
      http as unknown as HttpHandlers,
      events as unknown as EventHandlers,
      notifications as unknown as NotificationService,
      consumer as unknown as NotificationConsumer,
    ).onModuleInit();
  });

  describe('HTTP Handlers', () => {
    it('registers notification list and mark-as-read operations from contract', () => {
      expect(
        [
          'notification_get__api_notifications',
          'notification_patch__api_notifications_id_read',
        ].every((operationId) => registeredHttp.has(operationId)),
      ).toBe(true);
    });

    it('delegates notification_get__api_notifications with authenticated principal subject', async () => {
      const handler = registeredHttp.get('notification_get__api_notifications');
      if (!handler) throw new Error('Handler not registered');

      notifications.list.mockResolvedValue({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      });

      const query = { page: '1', pageSize: '10', status: 'UNREAD' };
      await handler({
        params: {},
        query,
        body: {},
        principal: { sub: 'user-sub-123', role: 'USER' },
      });

      expect(notifications.list).toHaveBeenCalledWith('user-sub-123', query);
    });

    it('delegates notification_patch__api_notifications_id_read with id and principal subject', async () => {
      const handler = registeredHttp.get(
        'notification_patch__api_notifications_id_read',
      );
      if (!handler) throw new Error('Handler not registered');

      notifications.markAsRead.mockResolvedValue({
        id: 'notif-456',
        userId: 'user-sub-123',
        isRead: true,
      });

      await handler({
        params: { id: 'notif-456' },
        query: {},
        body: {},
        principal: { sub: 'user-sub-123', role: 'USER' },
      });

      expect(notifications.markAsRead).toHaveBeenCalledWith(
        'notif-456',
        'user-sub-123',
      );
    });
  });

  describe('Event Handlers', () => {
    it('registers bid.placed, auction.ended, and payment.succeeded event consumers', () => {
      expect(
        ['bid.placed', 'auction.ended', 'payment.succeeded'].every((eventName) =>
          registeredEvents.has(eventName),
        ),
      ).toBe(true);
    });

    it('delegates bid.placed to consumer.handleBidPlaced', async () => {
      const handler = registeredEvents.get('bid.placed');
      if (!handler) throw new Error('Handler not registered');

      const mockTx = {} as Transaction;
      const mockEvent = { eventName: 'bid.placed', eventId: 'ev-1' } as IntegrationEvent;
      await handler(mockTx, mockEvent);

      expect(consumer.handleBidPlaced).toHaveBeenCalledWith(mockTx, mockEvent);
    });

    it('delegates auction.ended to consumer.handleAuctionEnded', async () => {
      const handler = registeredEvents.get('auction.ended');
      if (!handler) throw new Error('Handler not registered');

      const mockTx = {} as Transaction;
      const mockEvent = { eventName: 'auction.ended', eventId: 'ev-2' } as IntegrationEvent;
      await handler(mockTx, mockEvent);

      expect(consumer.handleAuctionEnded).toHaveBeenCalledWith(mockTx, mockEvent);
    });

    it('delegates payment.succeeded to consumer.handlePaymentSucceeded', async () => {
      const handler = registeredEvents.get('payment.succeeded');
      if (!handler) throw new Error('Handler not registered');

      const mockTx = {} as Transaction;
      const mockEvent = { eventName: 'payment.succeeded', eventId: 'ev-3' } as IntegrationEvent;
      await handler(mockTx, mockEvent);

      expect(consumer.handlePaymentSucceeded).toHaveBeenCalledWith(mockTx, mockEvent);
    });
  });
});
