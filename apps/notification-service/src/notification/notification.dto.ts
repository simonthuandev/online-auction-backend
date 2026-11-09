import type { NotificationType } from '@prisma/client/notification/index.js';

export type NotificationStatusFilter = 'UNREAD' | 'READ';

export type NotificationListFilter = {
  page?: number | string;
  pageSize?: number | string;
  status?: string;
  search?: string;
  categoryId?: string;
};

export type NotificationResponse = {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: NotificationType;
  isRead: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type NotificationPageResponse = {
  items: NotificationResponse[];
  page: number;
  pageSize: number;
  total: number;
};

