import type { NotificationRecord } from './notification.repository.js';
import type {
  NotificationPageResponse,
  NotificationResponse,
} from './notification.dto.js';

export function toNotificationResponse(
  record: NotificationRecord,
): NotificationResponse {
  return {
    id: record.id,
    userId: record.userId,
    title: record.title,
    message: record.message,
    type: record.type,
    isRead: record.isRead,
    metadata:
      typeof record.metadata === 'object' && record.metadata !== null
        ? (record.metadata as Record<string, unknown>)
        : {},
    createdAt:
      record.createdAt instanceof Date
        ? record.createdAt.toISOString()
        : new Date(record.createdAt).toISOString(),
  };
}

export function toNotificationPage(
  items: NotificationRecord[],
  page: number,
  pageSize: number,
  total: number,
): NotificationPageResponse {
  return {
    items: items.map(toNotificationResponse),
    page,
    pageSize,
    total,
  };
}

