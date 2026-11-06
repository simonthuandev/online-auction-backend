import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    PermanentMessageError,
    type Transaction,
    type IntegrationEvent,
    type AuctionEndedPayload,
} from '@app/common';

@Injectable()
export class OrderConsumer {


    /**
     * Xử lý sự kiện auction.ended:
     * - Bỏ qua nếu không có người thắng (winnerId: null hoặc finalPrice: null).
     * - Ném PermanentMessageError nếu payload thiếu hoặc giá <= 0.
     * - Tạo Order idempotent (ON CONFLICT ("auctionId") DO NOTHING).
     */
    async handleAuctionEnded(
        tx: Transaction,
        event: IntegrationEvent,
    ): Promise<void> {
        if (event.eventName !== 'auction.ended') return;

        const payload = event.payload as AuctionEndedPayload;

        // Kiểm tra cấu trúc payload cơ bản
        if (!payload || typeof payload !== 'object') {
            throw new PermanentMessageError('INVALID_ORDER_PAYLOAD: Missing payload');
        }

        // Nhánh No-Winner: Phiên đấu giá kết thúc không có người thắng
        if (payload.winnerId === null || payload.finalPrice === null) {
            return;
        }

        // Kiểm tra các trường bắt buộc
        if (
            !payload.auctionId ||
            !payload.productId ||
            !payload.sellerId ||
            !payload.winnerId ||
            !payload.productTitle ||
            !payload.currency
        ) {
            throw new PermanentMessageError(
                'INVALID_ORDER_PAYLOAD: Missing required fields',
            );
        }

        // Kiểm tra giá chốt (finalPrice phải > 0)
        let amount: bigint;
        try {
            amount = BigInt(payload.finalPrice);
        } catch {
            throw new PermanentMessageError(
                'INVALID_ORDER_PAYLOAD: finalPrice is not a valid integer string',
            );
        }

        if (amount <= 0n) {
            throw new PermanentMessageError(
                'INVALID_ORDER_PAYLOAD: finalPrice must be greater than 0',
            );
        }

        // Ghi vào bảng "Order" bằng chính transaction tx
        // Dùng ON CONFLICT ("auctionId") DO NOTHING để đảm bảo tính Idempotent
        await tx.execute(
            `INSERT INTO "Order" (
        "id", "auctionId", "productId", "buyerId", "sellerId",
        "totalAmount", "currency", "status", "productTitle", "productThumbnail",
        "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6::numeric, $7, 'PENDING_PAYMENT'::"OrderStatus", $8, $9, now(), now()
      ) ON CONFLICT ("auctionId") DO NOTHING`,
            randomUUID(),
            payload.auctionId,
            payload.productId,
            payload.winnerId, // Buyer chính là Winner
            payload.sellerId,
            payload.finalPrice,
            payload.currency,
            payload.productTitle,
            payload.productThumbnail ?? null,
        );
    }
}