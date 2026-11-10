import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import { NotificationService } from './notification/notification.service.js';
import { NotificationConsumer } from './notification/consumers/notification.consumer.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly notifications: NotificationService,
    private readonly consumer: NotificationConsumer,
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

    // Event consumers
    this.events.register('bid.placed', async (tx, event) =>
      this.consumer.handleBidPlaced(tx, event),
    );
    this.events.register('auction.ended', async (tx, event) =>
      this.consumer.handleAuctionEnded(tx, event),
    );
    this.events.register('payment.succeeded', async (tx, event) =>
      this.consumer.handlePaymentSucceeded(tx, event),
    );
  }
}
