import { Injectable, Logger } from '@nestjs/common';
import {
    PermanentMessageError,
    type Transaction,
    type IntegrationEvent,
} from '@app/common';

export interface PaymentSucceededPayload {
    paymentId: string;
    orderId: string;
    userId: string;
    amount: string;
    currency: 'VND';
    paymentMethod: 'COD' | 'VNPAY';
    transactionId: string;
    paidAt: string;
}

interface OrderRow {
    id: string;
    buyerId: string;
    sellerId: string;
    totalAmount: string | number;
    currency: string;
    status: 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED' | 'COMPLETED';
    paymentId: string | null;
    paidAt: string | Date | null;
}

@Injectable()
export class PaymentConsumer {
    private readonly logger = new Logger(PaymentConsumer.name);

    /**
     * Xử lý sự kiện payment.succeeded:
     * - Tìm Order theo payload.orderId (FOR UPDATE).
     * - Order chưa tồn tại -> Error (để RabbitMQ retry).
     * - Order CANCELLED -> PermanentMessageError.
     * - Đối chiếu buyerId == userId, totalAmount::text == amount, currency.
     *   Không khớp -> PermanentMessageError('PAYMENT_ORDER_MISMATCH').
     * - PENDING_PAYMENT -> cập nhật status PAID, set paymentId, paidAt.
     * - Event trùng/Order đã PAID với cùng paymentId -> no-op.
     * - PAID với paymentId khác -> PermanentMessageError + log.
     */

    async handlePaymentSucceeded(
        tx: Transaction,
        event: IntegrationEvent,
    ): Promise<void> {
        if (event.eventName !== 'payment.succeeded') return;

        const payload = event.payload as PaymentSucceededPayload;

        if (!payload || typeof payload !== 'object') {
            throw new PermanentMessageError('INVALID_PAYMENT_PAYLOAD: Missing payload');
        }

        if (
            !payload.orderId ||
            !payload.paymentId ||
            !payload.userId ||
            !payload.amount ||
            !payload.currency ||
            !payload.paidAt
        ) {
            throw new PermanentMessageError('INVALID_PAYMENT_PAYLOAD: Missing required fields');
        }

        // Tìm Order theo payload.orderId với khóa FOR UPDATE
        const orders = await tx.query<OrderRow>(
            'SELECT id, "buyerId", "sellerId", "totalAmount"::text, currency, status, "paymentId", "paidAt" FROM "Order" WHERE id = $1 FOR UPDATE',
            payload.orderId,
        );

        const order = orders[0];

        // Order chưa tồn tại -> ném Error thường để RabbitMQ retry
        if (!order) {
            throw new Error(`ORDER_NOT_FOUND: Order ${payload.orderId} not found, retrying...`);
        }

        // Order đã CANCELLED -> ném PermanentMessageError (không retry)
        if (order.status === 'CANCELLED') {
            throw new PermanentMessageError(
                `ORDER_CANCELLED: Order ${order.id} has already been cancelled`,
            );
        }

        // Đối chiếu buyerId == userId, totalAmount == amount, currency
        const orderAmount = String(order.totalAmount).split('.')[0];
        const eventAmount = String(payload.amount).split('.')[0];

        if (
            order.buyerId !== payload.userId ||
            orderAmount !== eventAmount ||
            order.currency !== payload.currency
        ) {
            this.logger.error(
                `PAYMENT_ORDER_MISMATCH for order ${order.id}: expected buyer=${order.buyerId}, amount=${orderAmount}, currency=${order.currency}; received buyer=${payload.userId}, amount=${eventAmount}, currency=${payload.currency}`,
            );
            throw new PermanentMessageError('PAYMENT_ORDER_MISMATCH');
        }

        // Xử lý trạng thái và tính Idempotency
        if (order.status === 'PAID') {
            if (order.paymentId === payload.paymentId) {
                // Event trùng lặp với cùng paymentId -> no-op
                return;
            }
            // Đã PAID nhưng với paymentId khác -> ghi log cảnh báo + permanent error
            this.logger.error(
                `Conflict: Order ${order.id} is already PAID with paymentId=${order.paymentId}, received different paymentId=${payload.paymentId}`,
            );
            throw new PermanentMessageError('ORDER_ALREADY_PAID_WITH_DIFFERENT_PAYMENT');
        }

        if (order.status === 'COMPLETED') {
            if (order.paymentId === payload.paymentId) {
                return;
            }
            throw new PermanentMessageError('ORDER_ALREADY_COMPLETED');
        }

        if (order.status === 'PENDING_PAYMENT') {
            // Cập nhật Order sang PAID
            await tx.execute(
                'UPDATE "Order" SET status = \'PAID\'::"OrderStatus", "paymentId" = $1, "paidAt" = $2::timestamp, "updatedAt" = now() WHERE id = $3',
                payload.paymentId,
                new Date(payload.paidAt).toISOString(),
                order.id,
            );
        }
    }
}
