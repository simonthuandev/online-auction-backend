import {
  PermanentMessageError,
  type IntegrationEvent,
} from '@app/common';
import type { NotificationType } from '../notification.dto.js';

export type BidPlacedEvent = Extract<
  IntegrationEvent,
  { eventName: 'bid.placed' }
>;
export type AuctionEndedEvent = Extract<
  IntegrationEvent,
  { eventName: 'auction.ended' }
>;
export type PaymentSucceededEvent = Extract<
  IntegrationEvent,
  { eventName: 'payment.succeeded' }
>;

export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
}

/**
 * Hàm thuần tạo bản nháp thông báo từ sự kiện bid.placed:
 * - previousBidderId khác null và khác newBidderId -> tạo 1 thông báo OUTBID cho previousBidder.
 * - Ngược lại (không có người trước hoặc người trước tự nâng giá) -> không tạo gì ([]).
 * - Không chứa thông tin nhạy cảm: không email, không ID của người trả giá mới.
 */
export function buildNotificationsFromBidPlaced(
  event: IntegrationEvent,
): NotificationDraft[] {
  if (!event || typeof event !== 'object') {
    throw new PermanentMessageError('INVALID_EVENT: Event is missing');
  }
  if (event.eventName !== 'bid.placed') {
    throw new PermanentMessageError(
      `INVALID_EVENT_NAME: Expected bid.placed but got ${event.eventName}`,
    );
  }

  const payload = (event as BidPlacedEvent).payload;
  if (!payload || typeof payload !== 'object') {
    throw new PermanentMessageError('INVALID_EVENT_PAYLOAD: Payload is missing');
  }

  const {
    auctionId,
    productId,
    productTitle,
    newBidderId,
    previousBidderId,
    currentPrice,
    currency,
  } = payload;

  if (
    !auctionId ||
    !productId ||
    !productTitle ||
    !newBidderId ||
    !currentPrice ||
    previousBidderId === undefined
  ) {
    throw new PermanentMessageError(
      'INVALID_EVENT_PAYLOAD: Missing required fields in bid.placed',
    );
  }

  // Không có người trước hoặc tự nâng giá chính mình -> không thông báo OUTBID
  if (previousBidderId === null || previousBidderId === newBidderId) {
    return [];
  }

  return [
    {
      userId: previousBidderId,
      type: 'OUTBID',
      title: 'Bạn đã bị vượt giá!',
      message: `Đã có người đặt giá cao hơn cho sản phẩm "${productTitle}".`,
      metadata: {
        auctionId,
        productId,
        currentPrice,
        currency: currency || 'VND',
      },
    },
  ];
}

/**
 * Hàm thuần tạo bản nháp thông báo từ sự kiện auction.ended:
 * - Có winner: tạo AUCTION_WON cho winner và AUCTION_ENDED cho seller.
 * - Không có winner: chỉ tạo AUCTION_ENDED cho seller.
 * - Không chứa thông tin nhạy cảm (không PII, không chéo user ID trong message/metadata).
 */
export function buildNotificationsFromAuctionEnded(
  event: IntegrationEvent,
): NotificationDraft[] {
  if (!event || typeof event !== 'object') {
    throw new PermanentMessageError('INVALID_EVENT: Event is missing');
  }
  if (event.eventName !== 'auction.ended') {
    throw new PermanentMessageError(
      `INVALID_EVENT_NAME: Expected auction.ended but got ${event.eventName}`,
    );
  }

  const payload = (event as AuctionEndedEvent).payload;
  if (!payload || typeof payload !== 'object') {
    throw new PermanentMessageError('INVALID_EVENT_PAYLOAD: Payload is missing');
  }

  const {
    auctionId,
    productId,
    productTitle,
    sellerId,
    winnerId,
    finalPrice,
    currency,
  } = payload;

  if (
    !auctionId ||
    !productId ||
    !productTitle ||
    !sellerId ||
    winnerId === undefined ||
    finalPrice === undefined
  ) {
    throw new PermanentMessageError(
      'INVALID_EVENT_PAYLOAD: Missing required fields in auction.ended',
    );
  }

  const drafts: NotificationDraft[] = [];

  if (winnerId !== null) {
    if (!finalPrice) {
      throw new PermanentMessageError(
        'INVALID_EVENT_PAYLOAD: finalPrice cannot be null or empty when winner exists',
      );
    }

    // 1. Thông báo AUCTION_WON cho người thắng cuộc (không chứa sellerId)
    drafts.push({
      userId: winnerId,
      type: 'AUCTION_WON',
      title: 'Chúc mừng! Bạn đã thắng phiên đấu giá',
      message: `Bạn đã thắng phiên đấu giá sản phẩm "${productTitle}" với mức giá ${finalPrice} ${currency || 'VND'}.`,
      metadata: {
        auctionId,
        productId,
        finalPrice,
        currency: currency || 'VND',
      },
    });

    // 2. Thông báo AUCTION_ENDED cho người bán (không chứa winnerId)
    drafts.push({
      userId: sellerId,
      type: 'AUCTION_ENDED',
      title: 'Phiên đấu giá đã kết thúc',
      message: `Phiên đấu giá sản phẩm "${productTitle}" đã kết thúc thành công với người thắng cuộc.`,
      metadata: {
        auctionId,
        productId,
        finalPrice,
        currency: currency || 'VND',
      },
    });
  } else {
    // Không có người thắng cuộc -> chỉ gửi AUCTION_ENDED cho seller
    drafts.push({
      userId: sellerId,
      type: 'AUCTION_ENDED',
      title: 'Phiên đấu giá đã kết thúc',
      message: `Phiên đấu giá sản phẩm "${productTitle}" đã kết thúc mà không có người trả giá thành công.`,
      metadata: {
        auctionId,
        productId,
      },
    });
  }

  return drafts;
}

/**
 * Hàm thuần tạo bản nháp thông báo từ sự kiện payment.succeeded:
 * - Tạo đúng 1 thông báo PAYMENT_SUCCESS cho người mua (userId).
 * - metadata CHỈ gồm: orderId, paymentId, paymentMethod.
 * - Tuyệt đối không chứa: transactionId, providerResponse, token/chữ ký, mã tham chiếu nhà cung cấp hay bí mật thanh toán.
 * - Hỗ trợ cả 2 phương thức COD và VNPAY.
 * - Lỗi thiếu trường bắt buộc hoặc sai phương thức -> ném PermanentMessageError.
 */
export function buildNotificationsFromPaymentSucceeded(
  event: IntegrationEvent,
): NotificationDraft[] {
  if (!event || typeof event !== 'object') {
    throw new PermanentMessageError('INVALID_EVENT: Event is missing');
  }
  if (event.eventName !== 'payment.succeeded') {
    throw new PermanentMessageError(
      `INVALID_EVENT_NAME: Expected payment.succeeded but got ${event.eventName}`,
    );
  }

  const payload = (event as PaymentSucceededEvent).payload;
  if (!payload || typeof payload !== 'object') {
    throw new PermanentMessageError('INVALID_EVENT_PAYLOAD: Payload is missing');
  }

  const {
    paymentId,
    orderId,
    userId,
    amount,
    currency,
    paymentMethod,
    transactionId,
    paidAt,
  } = payload;

  if (
    !paymentId ||
    typeof paymentId !== 'string' ||
    !paymentId.trim() ||
    !orderId ||
    typeof orderId !== 'string' ||
    !orderId.trim() ||
    !userId ||
    typeof userId !== 'string' ||
    !userId.trim() ||
    !amount ||
    typeof amount !== 'string' ||
    !amount.trim() ||
    currency !== 'VND' ||
    !paymentMethod ||
    !transactionId ||
    typeof transactionId !== 'string' ||
    !transactionId.trim() ||
    !paidAt ||
    typeof paidAt !== 'string' ||
    !paidAt.trim()
  ) {
    throw new PermanentMessageError(
      'INVALID_EVENT_PAYLOAD: Missing required fields in payment.succeeded',
    );
  }

  if (paymentMethod !== 'COD' && paymentMethod !== 'VNPAY') {
    throw new PermanentMessageError(
      `INVALID_EVENT_PAYLOAD: Unsupported paymentMethod ${String(paymentMethod)}`,
    );
  }

  const message =
    paymentMethod === 'COD'
      ? 'Đơn hàng của bạn đã được xác nhận thanh toán thành công (COD - Tiền mặt khi nhận hàng).'
      : 'Đơn hàng của bạn đã được thanh toán thành công qua VNPAY.';

  return [
    {
      userId,
      type: 'PAYMENT_SUCCESS',
      title: 'Thanh toán thành công',
      message,
      metadata: {
        orderId,
        paymentId,
        paymentMethod,
      },
    },
  ];
}
