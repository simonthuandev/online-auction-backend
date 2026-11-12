import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  PermanentMessageError,
  type IntegrationEvent,
} from '../../../../../libs/common/src/index.js';
import {
  buildNotificationsFromBidPlaced,
  buildNotificationsFromAuctionEnded,
  buildNotificationsFromPaymentSucceeded,
} from './notification-event.builder.js';

type BidPlacedEvent = Extract<IntegrationEvent, { eventName: 'bid.placed' }>;
type AuctionEndedEvent = Extract<IntegrationEvent, { eventName: 'auction.ended' }>;
type PaymentSucceededEvent = Extract<IntegrationEvent, { eventName: 'payment.succeeded' }>;

describe('notification-event.builder (Hàm thuần dựng thông báo từ event)', () => {
  describe('buildNotificationsFromBidPlaced', () => {
    const validBidPlacedEvent: BidPlacedEvent = {
      eventId: randomUUID(),
      eventName: 'bid.placed',
      schemaVersion: 1,
      occurredAt: '2026-11-10T10:00:00.000Z',
      producer: 'auction',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      correlationId: randomUUID(),
      payload: {
        auctionId: randomUUID(),
        productId: randomUUID(),
        productTitle: 'Đồng hồ cổ Thụy Sĩ',
        newBidderId: 'buyer-02',
        previousBidderId: 'buyer-01',
        currentPrice: '2500000',
        currency: 'VND',
        bidTime: '2026-11-10T10:00:00.000Z',
      },
    };

    it('tạo 1 thông báo OUTBID cho previousBidderId khi bị người khác vượt giá', () => {
      const drafts = buildNotificationsFromBidPlaced(validBidPlacedEvent);

      expect(drafts).toHaveLength(1);
      const [draft] = drafts;
      expect(draft.userId).toBe('buyer-01');
      expect(draft.type).toBe('OUTBID');
      expect(draft.title).toBe('Bạn đã bị vượt giá!');
      expect(draft.message).toContain('Đồng hồ cổ Thụy Sĩ');
      expect(draft.metadata).toEqual({
        auctionId: validBidPlacedEvent.payload.auctionId,
        productId: validBidPlacedEvent.payload.productId,
        currentPrice: '2500000',
        currency: 'VND',
      });
    });

    it('không chứa dữ liệu nhạy cảm của người trả giá mới (không email, không newBidderId)', () => {
      const drafts = buildNotificationsFromBidPlaced(validBidPlacedEvent);
      const [draft] = drafts;

      expect(draft.message).not.toContain('buyer-02');
      expect(draft.title).not.toContain('buyer-02');
      expect(JSON.stringify(draft.metadata)).not.toContain('buyer-02');
      expect(JSON.stringify(draft)).not.toContain('@');
    });

    it('không tạo thông báo khi previousBidderId = null (lần đặt giá đầu tiên)', () => {
      const event: BidPlacedEvent = {
        ...validBidPlacedEvent,
        payload: {
          ...validBidPlacedEvent.payload,
          previousBidderId: null,
        },
      };

      const drafts = buildNotificationsFromBidPlaced(event);
      expect(drafts).toEqual([]);
    });

    it('không tạo thông báo khi previousBidderId bằng newBidderId (người dùng tự nâng giá)', () => {
      const event: BidPlacedEvent = {
        ...validBidPlacedEvent,
        payload: {
          ...validBidPlacedEvent.payload,
          previousBidderId: 'buyer-02',
          newBidderId: 'buyer-02',
        },
      };

      const drafts = buildNotificationsFromBidPlaced(event);
      expect(drafts).toEqual([]);
    });

    it('ném PermanentMessageError khi thiếu payload hoặc sai eventName', () => {
      expect(() =>
        buildNotificationsFromBidPlaced({
          ...validBidPlacedEvent,
          eventName: 'auction.ended' as never,
        }),
      ).toThrow(PermanentMessageError);

      expect(() =>
        buildNotificationsFromBidPlaced({
          ...validBidPlacedEvent,
          payload: null as never,
        }),
      ).toThrow(PermanentMessageError);
    });

    it('ném PermanentMessageError khi thiếu trường bắt buộc', () => {
      const invalidEvent = {
        ...validBidPlacedEvent,
        payload: {
          ...validBidPlacedEvent.payload,
          auctionId: '',
        },
      };

      expect(() => buildNotificationsFromBidPlaced(invalidEvent)).toThrow(
        PermanentMessageError,
      );
    });
  });

  describe('buildNotificationsFromAuctionEnded', () => {
    const validAuctionEndedEvent: AuctionEndedEvent = {
      eventId: randomUUID(),
      eventName: 'auction.ended',
      schemaVersion: 1,
      occurredAt: '2026-11-10T11:00:00.000Z',
      producer: 'auction',
      aggregateId: randomUUID(),
      aggregateVersion: 1,
      correlationId: randomUUID(),
      payload: {
        auctionId: randomUUID(),
        productId: randomUUID(),
        productTitle: 'Tranh sơn dầu phố cổ',
        productThumbnail: 'https://example.com/painting.jpg',
        sellerId: 'seller-99',
        winnerId: 'winner-88',
        finalPrice: '15000000',
        currency: 'VND',
        endedAt: '2026-11-10T11:00:00.000Z',
      },
    };

    it('tạo 2 thông báo (AUCTION_WON cho winner và AUCTION_ENDED cho seller) khi có winner', () => {
      const drafts = buildNotificationsFromAuctionEnded(validAuctionEndedEvent);

      expect(drafts).toHaveLength(2);

      // 1. Cho winner
      const winnerDraft = drafts.find((d) => d.userId === 'winner-88');
      expect(winnerDraft).toBeDefined();
      expect(winnerDraft!.type).toBe('AUCTION_WON');
      expect(winnerDraft!.title).toBe('Chúc mừng! Bạn đã thắng phiên đấu giá');
      expect(winnerDraft!.message).toContain('Tranh sơn dầu phố cổ');
      expect(winnerDraft!.message).toContain('15000000 VND');
      expect(winnerDraft!.metadata).toEqual({
        auctionId: validAuctionEndedEvent.payload.auctionId,
        productId: validAuctionEndedEvent.payload.productId,
        finalPrice: '15000000',
        currency: 'VND',
      });
      // Không để lộ sellerId cho winner
      expect(JSON.stringify(winnerDraft)).not.toContain('seller-99');

      // 2. Cho seller
      const sellerDraft = drafts.find((d) => d.userId === 'seller-99');
      expect(sellerDraft).toBeDefined();
      expect(sellerDraft!.type).toBe('AUCTION_ENDED');
      expect(sellerDraft!.title).toBe('Phiên đấu giá đã kết thúc');
      expect(sellerDraft!.message).toContain('Tranh sơn dầu phố cổ');
      expect(sellerDraft!.metadata).toEqual({
        auctionId: validAuctionEndedEvent.payload.auctionId,
        productId: validAuctionEndedEvent.payload.productId,
        finalPrice: '15000000',
        currency: 'VND',
      });
      // Không để lộ winnerId cho seller
      expect(JSON.stringify(sellerDraft)).not.toContain('winner-88');
    });

    it('chỉ tạo 1 thông báo AUCTION_ENDED cho seller khi không có người thắng (winnerId = null)', () => {
      const noWinnerEvent: AuctionEndedEvent = {
        ...validAuctionEndedEvent,
        payload: {
          ...validAuctionEndedEvent.payload,
          winnerId: null,
          finalPrice: null,
        },
      };

      const drafts = buildNotificationsFromAuctionEnded(noWinnerEvent);

      expect(drafts).toHaveLength(1);
      const [sellerDraft] = drafts;
      expect(sellerDraft.userId).toBe('seller-99');
      expect(sellerDraft.type).toBe('AUCTION_ENDED');
      expect(sellerDraft.title).toBe('Phiên đấu giá đã kết thúc');
      expect(sellerDraft.message).toContain('không có người trả giá thành công');
      expect(sellerDraft.metadata).toEqual({
        auctionId: noWinnerEvent.payload.auctionId,
        productId: noWinnerEvent.payload.productId,
      });
    });

    it('ném PermanentMessageError khi có winner nhưng finalPrice bị null hoặc rỗng', () => {
      const invalidEvent: AuctionEndedEvent = {
        ...validAuctionEndedEvent,
        payload: {
          ...validAuctionEndedEvent.payload,
          winnerId: 'winner-88',
          finalPrice: null,
        },
      };

      expect(() => buildNotificationsFromAuctionEnded(invalidEvent)).toThrow(
        PermanentMessageError,
      );
    });

    it('ném PermanentMessageError khi thiếu trường bắt buộc', () => {
      const missingFieldEvent = {
        ...validAuctionEndedEvent,
        payload: {
          ...validAuctionEndedEvent.payload,
          sellerId: '',
        },
      };

      expect(() => buildNotificationsFromAuctionEnded(missingFieldEvent)).toThrow(
        PermanentMessageError,
      );
    });
  });

  describe('buildNotificationsFromPaymentSucceeded', () => {
    const validPaymentEvent: PaymentSucceededEvent = {
      eventId: '40000000-0000-4000-8000-000000000001',
      eventName: 'payment.succeeded',
      schemaVersion: 1,
      occurredAt: '2026-11-12T10:00:00.000Z',
      producer: 'payment',
      aggregateId: '20000000-0000-4000-8000-000000000001',
      aggregateVersion: 1,
      correlationId: '50000000-0000-4000-8000-000000000001',
      payload: {
        paymentId: '20000000-0000-4000-8000-000000000001',
        orderId: '30000000-0000-4000-8000-000000000001',
        userId: '10000000-0000-4000-8000-000000000001',
        amount: '1500000',
        currency: 'VND',
        paymentMethod: 'VNPAY',
        transactionId: 'VNPAY_SECRET_TXN_9999',
        paidAt: '2026-11-12T10:00:00.000Z',
      },
    };

    it('tạo đúng 1 thông báo PAYMENT_SUCCESS cho buyer (userId) với phương thức VNPAY', () => {
      const drafts = buildNotificationsFromPaymentSucceeded(validPaymentEvent);

      expect(drafts).toHaveLength(1);
      const [draft] = drafts;
      expect(draft.userId).toBe('10000000-0000-4000-8000-000000000001');
      expect(draft.type).toBe('PAYMENT_SUCCESS');
      expect(draft.title).toBe('Thanh toán thành công');
      expect(draft.message).toContain('VNPAY');
      expect(draft.metadata).toEqual({
        orderId: '30000000-0000-4000-8000-000000000001',
        paymentId: '20000000-0000-4000-8000-000000000001',
        paymentMethod: 'VNPAY',
      });
    });

    it('tạo thông báo PAYMENT_SUCCESS cho phương thức COD', () => {
      const codEvent: PaymentSucceededEvent = {
        ...validPaymentEvent,
        payload: {
          ...validPaymentEvent.payload,
          paymentMethod: 'COD',
          transactionId: 'COD_RECEIPT_123',
        },
      };

      const drafts = buildNotificationsFromPaymentSucceeded(codEvent);

      expect(drafts).toHaveLength(1);
      const [draft] = drafts;
      expect(draft.userId).toBe(validPaymentEvent.payload.userId);
      expect(draft.type).toBe('PAYMENT_SUCCESS');
      expect(draft.title).toBe('Thanh toán thành công');
      expect(draft.message).toContain('COD');
      expect(draft.metadata).toEqual({
        orderId: validPaymentEvent.payload.orderId,
        paymentId: validPaymentEvent.payload.paymentId,
        paymentMethod: 'COD',
      });
    });

    it('metadata chỉ có đúng 3 trường: orderId, paymentId, paymentMethod (không chứa transactionId, providerResponse, token, secret)', () => {
      const drafts = buildNotificationsFromPaymentSucceeded(validPaymentEvent);
      const [draft] = drafts;

      const keys = Object.keys(draft.metadata);
      expect(keys.sort()).toEqual(['orderId', 'paymentId', 'paymentMethod'].sort());

      // Tuyệt đối không chứa transactionId hoặc thông tin nhạy cảm
      expect(draft.metadata).not.toHaveProperty('transactionId');
      expect(draft.metadata).not.toHaveProperty('providerResponse');
      expect(draft.metadata).not.toHaveProperty('token');
      expect(draft.metadata).not.toHaveProperty('signature');
    });

    it('nội dung tiếng Việt không để lộ transactionId hay dữ liệu nhạy cảm', () => {
      const drafts = buildNotificationsFromPaymentSucceeded(validPaymentEvent);
      const [draft] = drafts;

      expect(draft.message).not.toContain('VNPAY_SECRET_TXN_9999');
      expect(draft.title).not.toContain('VNPAY_SECRET_TXN_9999');
      expect(JSON.stringify(draft.metadata)).not.toContain('VNPAY_SECRET_TXN_9999');
    });

    it('ném PermanentMessageError khi thiếu userId', () => {
      const invalidEvent = {
        ...validPaymentEvent,
        payload: {
          ...validPaymentEvent.payload,
          userId: '',
        },
      };

      expect(() => buildNotificationsFromPaymentSucceeded(invalidEvent as any)).toThrow(
        PermanentMessageError,
      );
    });

    it('ném PermanentMessageError khi thiếu orderId hoặc paymentId', () => {
      const missingOrderId = {
        ...validPaymentEvent,
        payload: {
          ...validPaymentEvent.payload,
          orderId: '',
        },
      };
      expect(() => buildNotificationsFromPaymentSucceeded(missingOrderId as any)).toThrow(
        PermanentMessageError,
      );

      const missingPaymentId = {
        ...validPaymentEvent,
        payload: {
          ...validPaymentEvent.payload,
          paymentId: '',
        },
      };
      expect(() => buildNotificationsFromPaymentSucceeded(missingPaymentId as any)).toThrow(
        PermanentMessageError,
      );
    });

    it('ném PermanentMessageError khi paymentMethod không hợp lệ', () => {
      const invalidMethodEvent = {
        ...validPaymentEvent,
        payload: {
          ...validPaymentEvent.payload,
          paymentMethod: 'STRIPE' as never,
        },
      };

      expect(() => buildNotificationsFromPaymentSucceeded(invalidMethodEvent as any)).toThrow(
        PermanentMessageError,
      );
    });

    it('ném PermanentMessageError khi sai eventName hoặc thiếu payload', () => {
      expect(() =>
        buildNotificationsFromPaymentSucceeded({
          ...validPaymentEvent,
          eventName: 'bid.placed' as never,
        }),
      ).toThrow(PermanentMessageError);

      expect(() =>
        buildNotificationsFromPaymentSucceeded({
          ...validPaymentEvent,
          payload: null as never,
        }),
      ).toThrow(PermanentMessageError);

      expect(() =>
        buildNotificationsFromPaymentSucceeded(null as never),
      ).toThrow(PermanentMessageError);
    });
  });
});
