import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type Notification,
} from '@prisma/client/notification/index.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export type NotificationRecord = Notification;

export type NotificationQueryFilter = {
  userId: string;
  isRead?: boolean;
  search?: string;
};

@Injectable()
export class NotificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findMany(
    page: number,
    pageSize: number,
    filter: NotificationQueryFilter,
  ): Promise<{ items: NotificationRecord[]; total: number }> {
    const where: Prisma.NotificationWhereInput = {
      userId: filter.userId,
      ...(filter.isRead !== undefined ? { isRead: filter.isRead } : {}),
      ...(filter.search
        ? {
            OR: [
              { title: { contains: filter.search, mode: 'insensitive' } },
              { message: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return { items, total };
  }

  async markAsRead(
    id: string,
    userId: string,
  ): Promise<NotificationRecord | null> {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });

    if (result.count === 0) {
      return null;
    }

    return this.prisma.notification.findFirst({
      where: { id, userId },
    });
  }
}
