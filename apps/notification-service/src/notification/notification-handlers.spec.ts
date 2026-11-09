import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandlers, HttpHandlers } from '@app/common';
import { ServiceHandlers } from '../service-handlers.js';
import { NotificationService } from './notification.service.js';

type TestRequest = {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  principal?: { sub: string; role: string };
};

describe('Notification HTTP handlers', () => {
  const registered = new Map<
    string,
    (request: TestRequest) => Promise<unknown>
  >();

  const http = {
    register: vi.fn(
      (
        operationId: string,
        handler: (request: TestRequest) => Promise<unknown>,
      ) => registered.set(operationId, handler),
    ),
  };

  const notifications = {
    list: vi.fn(),
    markAsRead: vi.fn(),
  };

  beforeEach(() => {
    registered.clear();
    vi.clearAllMocks();
    new ServiceHandlers(
      http as unknown as HttpHandlers,
      {} as EventHandlers,
      notifications as unknown as NotificationService,
    ).onModuleInit();
  });

  it('registers notification list and mark-as-read operations from contract', () => {
    expect(
      [
        'notification_get__api_notifications',
        'notification_patch__api_notifications_id_read',
      ].every((operationId) => registered.has(operationId)),
    ).toBe(true);
  });

  it('delegates notification_get__api_notifications with authenticated principal subject', async () => {
    const handler = registered.get('notification_get__api_notifications');
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
    const handler = registered.get(
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

