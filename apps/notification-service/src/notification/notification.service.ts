import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  NotificationListFilter,
  NotificationPageResponse,
  NotificationResponse,
} from './notification.dto.js';
import {
  toNotificationPage,
  toNotificationResponse,
} from './notification.mapper.js';
import { NotificationRepository } from './notification.repository.js';

@Injectable()
export class NotificationService {
  constructor(private readonly repository: NotificationRepository) {}

  async list(
    userId: string | undefined,
    query: NotificationListFilter,
  ): Promise<NotificationPageResponse> {
    if (!userId) {
      throw new ForbiddenException('User identity required');
    }

    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));

    let isRead: boolean | undefined = undefined;
    if (query.status !== undefined && query.status !== '') {
      if (query.status === 'UNREAD') {
        isRead = false;
      } else if (query.status === 'READ') {
        isRead = true;
      } else {
        throw new BadRequestException(
          'Invalid status filter; allowed values are UNREAD or READ',
        );
      }
    }

    const { items, total } = await this.repository.findMany(page, pageSize, {
      userId,
      isRead,
      search: typeof query.search === 'string' ? query.search : undefined,
    });

    return toNotificationPage(items, page, pageSize, total);
  }

  async markAsRead(
    id: string,
    userId: string | undefined,
  ): Promise<NotificationResponse> {
    if (!userId) {
      throw new ForbiddenException('User identity required');
    }

    const record = await this.repository.markAsRead(id, userId);
    if (!record) {
      throw new NotFoundException('Notification not found');
    }

    return toNotificationResponse(record);
  }
}

