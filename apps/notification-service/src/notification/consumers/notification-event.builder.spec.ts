import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  PermanentMessageError,
  type IntegrationEvent,
} from '../../../../../libs/common/src/index.js';
import {
  buildNotificationsFromBidPlaced,
  buildNotificationsFromAuctionEnded,
} from './notification-event.builder.js';

type BidPlacedEvent = Extract<IntegrationEvent, { eventName: 'bid.placed' }>;
type AuctionEndedEvent = Extract<IntegrationEvent, { eventName: 'auction.ended' }>;

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
});
