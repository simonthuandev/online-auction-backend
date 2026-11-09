import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import { NotificationService } from './notification/notification.service.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly notifications: NotificationService,
  ) { }
  onModuleInit() {
    this.http.register('notification_get__api_notifications', async (request) =>
      this.notifications.list(
        request.principal?.sub,
        request.query as Record<string, string>,
      ),
    );
    this.http.register(
      'notification_patch__api_notifications_id_read',
      async (request) =>
        this.notifications.markAsRead(
          String(request.params.id),
          request.principal?.sub,
        ),
    );
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.
  }
}
