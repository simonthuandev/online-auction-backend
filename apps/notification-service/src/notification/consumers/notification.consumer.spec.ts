import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  Realtime,
  type IntegrationEvent,
  type Transaction,
  PermanentMessageError,
} from '../../../../../libs/common/src/index.js';
import { NotificationConsumer } from './notification.consumer.js';
import type { NotificationRecord } from '../notification.repository.js';

type BidPlacedEvent = Extract<IntegrationEvent, { eventName: 'bid.placed' }>;
type AuctionEndedEvent = Extract<IntegrationEvent, { eventName: 'auction.ended' }>;
type PaymentSucceededEvent = Extract<IntegrationEvent, { eventName: 'payment.succeeded' }>;

describe('NotificationConsumer Unit Tests', () => {
  let consumer: NotificationConsumer;
  let mockTx: Transaction;
  let mockRealtime: { publishNotification: ReturnType<typeof vi.fn> };

  const validBidPlacedEvent: BidPlacedEvent = {
    eventId: '30000000-0000-4000-8000-000000000001',
    eventName: 'bid.placed',
    schemaVersion: 1,
    occurredAt: '2026-11-10T10:00:00.000Z',
    producer: 'auction',
    aggregateId: '20000000-0000-4000-8000-000000000001',
    aggregateVersion: 2,
    correlationId: randomUUID(),
    payload: {
      auctionId: '20000000-0000-4000-8000-000000000001',
      productId: '10000000-0000-4000-8000-000000000001',
      productTitle: 'Điện thoại thông minh',
      newBidderId: 'buyer-02',
      previousBidderId: 'buyer-01',
      currentPrice: '5000000',
      currency: 'VND',
      bidTime: '2026-11-10T10:00:00.000Z',
    },
  };

  const validAuctionEndedEvent: AuctionEndedEvent = {
    eventId: '30000000-0000-4000-8000-000000000002',
    eventName: 'auction.ended',
    schemaVersion: 1,
    occurredAt: '2026-11-10T11:00:00.000Z',
    producer: 'auction',
    aggregateId: '20000000-0000-4000-8000-000000000002',
    aggregateVersion: 5,
    correlationId: randomUUID(),
    payload: {
      auctionId: '20000000-0000-4000-8000-000000000002',
      productId: '10000000-0000-4000-8000-000000000002',
      productTitle: 'Laptop cao cấp',
      productThumbnail: null,
      sellerId: 'seller-01',
      winnerId: 'winner-01',
      finalPrice: '20000000',
      currency: 'VND',
      endedAt: '2026-11-10T11:00:00.000Z',
    },
  };

  beforeEach(() => {
    mockRealtime = {
      publishNotification: vi.fn(),
    };
    consumer = new NotificationConsumer(mockRealtime as unknown as Realtime);

    mockTx = {
      query: vi.fn(),
      execute: vi.fn(),
    };
  });

  describe('handleBidPlaced', () => {
    it('thực hiện INSERT vào DB với tham số chuẩn và trả về callback phát socket', async () => {
      const insertedRecord: NotificationRecord = {
        id: randomUUID(),
        userId: 'buyer-01',
        sourceEventId: validBidPlacedEvent.eventId,
        title: 'Bạn đã bị vượt giá!',
        message: 'Đã có người đặt giá cao hơn cho sản phẩm "Điện thoại thông minh".',
        type: 'OUTBID',
        isRead: false,
        metadata: {
          auctionId: validBidPlacedEvent.payload.auctionId,
          productId: validBidPlacedEvent.payload.productId,
          currentPrice: '5000000',
          currency: 'VND',
        },
        createdAt: new Date('2026-11-10T10:00:01.000Z'),
      };

      vi.mocked(mockTx.query).mockResolvedValueOnce([insertedRecord]);

      const callback = await consumer.handleBidPlaced(mockTx, validBidPlacedEvent);

      expect(mockTx.query).toHaveBeenCalledTimes(1);
      const [sql, ...params] = vi.mocked(mockTx.query).mock.calls[0];

      expect(sql).toContain('INSERT INTO "Notification"');
      expect(sql).toContain('ON CONFLICT ("sourceEventId", "userId", "type") DO NOTHING');
      expect(sql).toContain('RETURNING');
      expect(params[1]).toBe('buyer-01');
      expect(params[2]).toBe(validBidPlacedEvent.eventId);
      expect(params[5]).toBe('OUTBID');

      // Socket CHƯA ĐƯỢC PHÁT trong transaction
      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();

      // Thực thi callback sau commit
      expect(typeof callback).toBe('function');
      callback!();

      // Socket phát thành công
      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(1);
      expect(mockRealtime.publishNotification).toHaveBeenCalledWith('buyer-01', {
        id: insertedRecord.id,
        userId: 'buyer-01',
        title: insertedRecord.title,
        message: insertedRecord.message,
        type: 'OUTBID',
        isRead: false,
        metadata: insertedRecord.metadata,
        createdAt: '2026-11-10T10:00:01.000Z',
      });
    });

    it('không ghi DB và trả về undefined khi không có previousBidder hoặc tự nâng giá', async () => {
      const selfBidEvent: BidPlacedEvent = {
        ...validBidPlacedEvent,
        payload: {
          ...validBidPlacedEvent.payload,
          previousBidderId: 'buyer-02',
          newBidderId: 'buyer-02',
        },
      };

      const result = await consumer.handleBidPlaced(mockTx, selfBidEvent);

      expect(result).toBeUndefined();
      expect(mockTx.query).not.toHaveBeenCalled();
      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();
    });

    it('không phát socket khi bản ghi đã tồn tại (duplicate / conflict -> 0 rows returned)', async () => {
      // ON CONFLICT DO NOTHING -> RETURNING rỗng
      vi.mocked(mockTx.query).mockResolvedValueOnce([]);

      const callback = await consumer.handleBidPlaced(mockTx, validBidPlacedEvent);

      expect(mockTx.query).toHaveBeenCalledTimes(1);
      expect(callback).toBeUndefined();
      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();
    });

    it('bỏ qua và không ghi DB khi là event demo', async () => {
      const demoEvent = {
        ...validBidPlacedEvent,
        demo: { runId: randomUUID() },
      };

      const result = await consumer.handleBidPlaced(mockTx, demoEvent);

      expect(result).toBeUndefined();
      expect(mockTx.query).not.toHaveBeenCalled();
    });

    it('ném lỗi và không swallow khi câu lệnh ghi DB bị lỗi', async () => {
      vi.mocked(mockTx.query).mockRejectedValueOnce(new Error('DATABASE_CONNECTION_LOST'));

      await expect(consumer.handleBidPlaced(mockTx, validBidPlacedEvent)).rejects.toThrow(
        'DATABASE_CONNECTION_LOST',
      );
    });
  });

  describe('handleAuctionEnded', () => {
    it('ghi 2 bản ghi và trả về callback phát socket cho cả winner và seller khi có winner', async () => {
      const winnerRecord: NotificationRecord = {
        id: randomUUID(),
        userId: 'winner-01',
        sourceEventId: validAuctionEndedEvent.eventId,
        title: 'Chúc mừng! Bạn đã thắng phiên đấu giá',
        message: 'Bạn đã thắng phiên đấu giá sản phẩm "Laptop cao cấp" với mức giá 20000000 VND.',
        type: 'AUCTION_WON',
        isRead: false,
        metadata: {
          auctionId: validAuctionEndedEvent.payload.auctionId,
          productId: validAuctionEndedEvent.payload.productId,
          finalPrice: '20000000',
          currency: 'VND',
        },
        createdAt: new Date('2026-11-10T11:00:01.000Z'),
      };

      const sellerRecord: NotificationRecord = {
        id: randomUUID(),
        userId: 'seller-01',
        sourceEventId: validAuctionEndedEvent.eventId,
        title: 'Phiên đấu giá đã kết thúc',
        message: 'Phiên đấu giá sản phẩm "Laptop cao cấp" đã kết thúc thành công với người thắng cuộc.',
        type: 'AUCTION_ENDED',
        isRead: false,
        metadata: {
          auctionId: validAuctionEndedEvent.payload.auctionId,
          productId: validAuctionEndedEvent.payload.productId,
          finalPrice: '20000000',
          currency: 'VND',
        },
        createdAt: new Date('2026-11-10T11:00:01.000Z'),
      };

      vi.mocked(mockTx.query)
        .mockResolvedValueOnce([winnerRecord])
        .mockResolvedValueOnce([sellerRecord]);

      const callback = await consumer.handleAuctionEnded(mockTx, validAuctionEndedEvent);

      expect(mockTx.query).toHaveBeenCalledTimes(2);
      expect(typeof callback).toBe('function');

      // Chạy callback sau commit
      callback!();

      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(2);
      expect(mockRealtime.publishNotification).toHaveBeenCalledWith('winner-01', expect.objectContaining({
        type: 'AUCTION_WON',
        userId: 'winner-01',
      }));
      expect(mockRealtime.publishNotification).toHaveBeenCalledWith('seller-01', expect.objectContaining({
        type: 'AUCTION_ENDED',
        userId: 'seller-01',
      }));
    });

    it('ghi 1 bản ghi cho seller khi không có người thắng (winnerId = null)', async () => {
      const noWinnerEvent: AuctionEndedEvent = {
        ...validAuctionEndedEvent,
        payload: {
          ...validAuctionEndedEvent.payload,
          winnerId: null,
          finalPrice: null,
        },
      };

      const sellerRecord: NotificationRecord = {
        id: randomUUID(),
        userId: 'seller-01',
        sourceEventId: noWinnerEvent.eventId,
        title: 'Phiên đấu giá đã kết thúc',
        message: 'Phiên đấu giá sản phẩm "Laptop cao cấp" đã kết thúc mà không có người trả giá thành công.',
        type: 'AUCTION_ENDED',
        isRead: false,
        metadata: {
          auctionId: noWinnerEvent.payload.auctionId,
          productId: noWinnerEvent.payload.productId,
        },
        createdAt: new Date('2026-11-10T11:00:01.000Z'),
      };

      vi.mocked(mockTx.query).mockResolvedValueOnce([sellerRecord]);

      const callback = await consumer.handleAuctionEnded(mockTx, noWinnerEvent);

      expect(mockTx.query).toHaveBeenCalledTimes(1);
      expect(typeof callback).toBe('function');

      callback!();

      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(1);
      expect(mockRealtime.publishNotification).toHaveBeenCalledWith('seller-01', expect.objectContaining({
        type: 'AUCTION_ENDED',
        userId: 'seller-01',
      }));
    });
  });

  describe('Realtime error resilience in callback', () => {
    it('bắt lỗi khi socket emit thất bại, ghi log và tiếp tục phát các thông báo còn lại', async () => {
      const record1: NotificationRecord = {
        id: randomUUID(),
        userId: 'user-01',
        sourceEventId: validAuctionEndedEvent.eventId,
        title: 'T1',
        message: 'M1',
        type: 'AUCTION_WON',
        isRead: false,
        metadata: {},
        createdAt: new Date(),
      };
      const record2: NotificationRecord = {
        id: randomUUID(),
        userId: 'user-02',
        sourceEventId: validAuctionEndedEvent.eventId,
        title: 'T2',
        message: 'M2',
        type: 'AUCTION_ENDED',
        isRead: false,
        metadata: {},
        createdAt: new Date(),
      };

      vi.mocked(mockTx.query)
        .mockResolvedValueOnce([record1])
        .mockResolvedValueOnce([record2]);

      // Giả lập user-01 bị lỗi kết nối socket/redis
      mockRealtime.publishNotification.mockImplementationOnce(() => {
        throw new Error('REDIS_SOCKET_BROKEN');
      });

      const callback = await consumer.handleAuctionEnded(mockTx, validAuctionEndedEvent);
      expect(typeof callback).toBe('function');

      // Callback không được throw exception
      expect(() => callback!()).not.toThrow();

      // Vẫn tiếp tục phát cho user-02
      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(2);
      expect(mockRealtime.publishNotification).toHaveBeenLastCalledWith('user-02', expect.objectContaining({
        userId: 'user-02',
      }));
    });
  });

  describe('handlePaymentSucceeded', () => {
    const validPaymentEvent: PaymentSucceededEvent = {
      eventId: '40000000-0000-4000-8000-000000000001',
      eventName: 'payment.succeeded',
      schemaVersion: 1,
      occurredAt: '2026-11-12T10:00:00.000Z',
      producer: 'payment',
      aggregateId: '20000000-0000-4000-8000-000000000001',
      aggregateVersion: 1,
      correlationId: randomUUID(),
      payload: {
        paymentId: '20000000-0000-4000-8000-000000000001',
        orderId: '30000000-0000-4000-8000-000000000001',
        userId: 'buyer-01',
        amount: '1000000',
        currency: 'VND',
        paymentMethod: 'VNPAY',
        transactionId: 'TXN123',
        paidAt: '2026-11-12T10:00:00.000Z',
      },
    };

    it('thực hiện INSERT vào DB với type = PAYMENT_SUCCESS và trả về callback phát socket', async () => {
      const insertedRecord: NotificationRecord = {
        id: randomUUID(),
        userId: 'buyer-01',
        sourceEventId: validPaymentEvent.eventId,
        title: 'Thanh toán thành công',
        message: 'Đơn hàng của bạn đã được thanh toán thành công qua VNPAY.',
        type: 'PAYMENT_SUCCESS',
        isRead: false,
        metadata: {
          orderId: validPaymentEvent.payload.orderId,
          paymentId: validPaymentEvent.payload.paymentId,
          paymentMethod: 'VNPAY',
        },
        createdAt: new Date('2026-11-12T10:00:01.000Z'),
      };

      vi.mocked(mockTx.query).mockResolvedValueOnce([insertedRecord]);

      const callback = await consumer.handlePaymentSucceeded(mockTx, validPaymentEvent);

      expect(mockTx.query).toHaveBeenCalledTimes(1);
      const [sql, ...params] = vi.mocked(mockTx.query).mock.calls[0];
      expect(sql).toContain('INSERT INTO "Notification"');
      expect(sql).toContain('ON CONFLICT ("sourceEventId", "userId", "type") DO NOTHING');
      expect(params[1]).toBe('buyer-01');
      expect(params[2]).toBe(validPaymentEvent.eventId);
      expect(params[5]).toBe('PAYMENT_SUCCESS');

      // Callback chưa chạy -> socket chưa được gọi
      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();

      // Khi commit xong -> gọi callback phát socket
      expect(typeof callback).toBe('function');
      callback!();

      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(1);
      expect(mockRealtime.publishNotification).toHaveBeenCalledWith('buyer-01', {
        id: insertedRecord.id,
        userId: 'buyer-01',
        title: 'Thanh toán thành công',
        message: 'Đơn hàng của bạn đã được thanh toán thành công qua VNPAY.',
        type: 'PAYMENT_SUCCESS',
        isRead: false,
        metadata: {
          orderId: validPaymentEvent.payload.orderId,
          paymentId: validPaymentEvent.payload.paymentId,
          paymentMethod: 'VNPAY',
        },
        createdAt: '2026-11-12T10:00:01.000Z',
      });
    });

    it('hỗ trợ phương thức thanh toán COD', async () => {
      const codEvent: PaymentSucceededEvent = {
        ...validPaymentEvent,
        payload: {
          ...validPaymentEvent.payload,
          paymentMethod: 'COD',
          transactionId: 'COD_RECEIPT_888',
        },
      };

      const insertedRecord: NotificationRecord = {
        id: randomUUID(),
        userId: 'buyer-01',
        sourceEventId: codEvent.eventId,
        title: 'Thanh toán thành công',
        message: 'Đơn hàng của bạn đã được xác nhận thanh toán thành công (COD - Tiền mặt khi nhận hàng).',
        type: 'PAYMENT_SUCCESS',
        isRead: false,
        metadata: {
          orderId: codEvent.payload.orderId,
          paymentId: codEvent.payload.paymentId,
          paymentMethod: 'COD',
        },
        createdAt: new Date('2026-11-12T10:00:01.000Z'),
      };

      vi.mocked(mockTx.query).mockResolvedValueOnce([insertedRecord]);

      const callback = await consumer.handlePaymentSucceeded(mockTx, codEvent);
      expect(typeof callback).toBe('function');
      callback!();

      expect(mockRealtime.publishNotification).toHaveBeenCalledTimes(1);
      expect(mockRealtime.publishNotification).toHaveBeenCalledWith('buyer-01', expect.objectContaining({
        type: 'PAYMENT_SUCCESS',
        metadata: expect.objectContaining({ paymentMethod: 'COD' }),
      }));
    });

    it('idempotent: khi nhận lại cùng event (replay) -> DB trả về 0 dòng và không phát socket', async () => {
      // Giả lập ON CONFLICT DO NOTHING -> 0 dòng được insert
      vi.mocked(mockTx.query).mockResolvedValueOnce([]);

      const callback = await consumer.handlePaymentSucceeded(mockTx, validPaymentEvent);

      expect(mockTx.query).toHaveBeenCalledTimes(1);
      expect(callback).toBeUndefined();
      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();
    });

    it('bỏ qua xử lý khi là demo event', async () => {
      const demoEvent = {
        ...validPaymentEvent,
        demo: { runId: randomUUID() },
      };

      const result = await consumer.handlePaymentSucceeded(mockTx, demoEvent as any);

      expect(result).toBeUndefined();
      expect(mockTx.query).not.toHaveBeenCalled();
      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();
    });

    it('ném lỗi khi DB query thất bại để transaction rollback và retry', async () => {
      vi.mocked(mockTx.query).mockRejectedValueOnce(new Error('DATABASE_CONNECTION_LOST'));

      await expect(
        consumer.handlePaymentSucceeded(mockTx, validPaymentEvent),
      ).rejects.toThrow('DATABASE_CONNECTION_LOST');

      expect(mockRealtime.publishNotification).not.toHaveBeenCalled();
    });

    it('ném PermanentMessageError khi payload thiếu trường bắt buộc', async () => {
      const invalidEvent = {
        ...validPaymentEvent,
        payload: {
          ...validPaymentEvent.payload,
          userId: '',
        },
      };

      await expect(
        consumer.handlePaymentSucceeded(mockTx, invalidEvent as any),
      ).rejects.toThrow(PermanentMessageError);

      expect(mockTx.query).not.toHaveBeenCalled();
    });
  });
});

