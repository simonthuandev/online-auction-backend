import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Realtime,
  type Transaction,
  type IntegrationEvent,
} from '@app/common';
import {
  buildNotificationsFromBidPlaced,
  buildNotificationsFromAuctionEnded,
  type NotificationDraft,
} from './notification-event.builder.js';
import { toNotificationResponse } from '../notification.mapper.js';
import type { NotificationRecord } from '../notification.repository.js';

@Injectable()
export class NotificationConsumer {
  private readonly logger = new Logger(NotificationConsumer.name);

  constructor(private readonly realtime: Realtime) {}

  /**
   * Xử lý sự kiện bid.placed:
   * Tạo thông báo OUTBID nếu có previousBidderId khác newBidderId.
   */
  async handleBidPlaced(
    tx: Transaction,
    event: IntegrationEvent,
  ): Promise<(() => void) | void> {
    if ((event as { demo?: unknown }).demo) {
      return;
    }

    const drafts = buildNotificationsFromBidPlaced(event);
    return this.persistAndDispatch(tx, event.eventId, drafts);
  }

  /**
   * Xử lý sự kiện auction.ended:
   * Tạo thông báo AUCTION_WON cho winner và AUCTION_ENDED cho seller.
   */
  async handleAuctionEnded(
    tx: Transaction,
    event: IntegrationEvent,
  ): Promise<(() => void) | void> {
    if ((event as { demo?: unknown }).demo) {
      return;
    }

    const drafts = buildNotificationsFromAuctionEnded(event);
    return this.persistAndDispatch(tx, event.eventId, drafts);
  }

  /**
   * Handler tạm thời no-op cho payment.succeeded.
   * TODO NOTIF-03: Triển khai lưu thông báo PAYMENT_SUCCESS khi thanh toán thành công.
   */
  async handlePaymentSucceeded(
    _tx: Transaction,
    event: IntegrationEvent,
  ): Promise<void> {
    this.logger.log(
      `[TODO NOTIF-03] Received payment.succeeded event ${event.eventId} (aggregateId: ${event.aggregateId}). No-op handler for NOTIF-02.`,
    );
  }

  /**
   * Ghi các thông báo vào DB trong transaction tx:
   * - INSERT ... ON CONFLICT ("sourceEventId","userId","type") DO NOTHING RETURNING ...
   * - Chỉ những bản ghi thực sự được insert mới được phát socket.
   * - Trả về callback thực thi sau khi transaction commit thành công.
   */
  private async persistAndDispatch(
    tx: Transaction,
    sourceEventId: string,
    drafts: NotificationDraft[],
  ): Promise<(() => void) | void> {
    if (!drafts.length) {
      return;
    }

    const inserted: NotificationRecord[] = [];

    for (const draft of drafts) {
      const rows = await tx.query<NotificationRecord>(
        `INSERT INTO "Notification" ("id", "userId", "sourceEventId", "title", "message", "type", "isRead", "metadata", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6::"NotificationType", false, $7::jsonb, now())
         ON CONFLICT ("sourceEventId", "userId", "type") DO NOTHING
         RETURNING "id", "userId", "sourceEventId", "title", "message", "type", "isRead", "metadata", "createdAt"`,
        randomUUID(),
        draft.userId,
        sourceEventId,
        draft.title,
        draft.message,
        draft.type,
        JSON.stringify(draft.metadata),
      );

      if (rows && rows.length > 0) {
        inserted.push(rows[0]);
      }
    }

    if (!inserted.length) {
      return;
    }

    // Callback thực thi sau khi platform commit transaction thành công
    return () => {
      for (const record of inserted) {
        try {
          const payload = toNotificationResponse(record);
          this.realtime.publishNotification(record.userId, payload);
        } catch (error) {
          this.logger.warn(
            `Failed to publish realtime notification to user ${record.userId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    };
  }
}

