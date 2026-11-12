import {
    Injectable,
    Inject,
    NotFoundException,
    ConflictException,
    ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
    PLATFORM_DB,
    type Database,
    type Principal,
    type IntegrationEvent,
    enqueueEvent,
} from '@app/common';
import type { PaymentResponse } from '../payment.service.js';

interface PaymentRow {
    id: string;
    orderId: string;
    userId: string;
    amount: number | string;
    currency: string;
    status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';
}

interface PaymentAttemptRow {
    id: string;
    paymentId: string;
    paymentMethod: 'COD' | 'VNPAY';
    providerReference: string;
    status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';
    expiresAt: string | Date;
}

@Injectable()
export class CodService {
    constructor(@Inject(PLATFORM_DB) private readonly db: Database) { }

    /**
     * Xác nhận đã thu tiền COD cho Payment
     * - Chỉ ADMIN có quyền thực hiện
     * - Khóa FOR UPDATE tránh tranh chấp đồng thời
     * - Cập nhật SUCCESS và ghi sự kiện payment.succeeded vào Outbox
     */

    async confirmCodPayment(
        paymentId: string,
        principal: Principal,
        correlationId?: string,
    ): Promise<PaymentResponse> {
        // Kiểm tra quyền ADMIN
        if (principal.role !== 'ADMIN') {
            throw new ForbiddenException('Forbidden: Only ADMIN can confirm COD payments');
        }

        return this.db.transaction(async (tx) => {
            // Khóa Payment FOR UPDATE
            const payments = await tx.query<PaymentRow>(
                'SELECT id, "orderId", "userId", amount::text, currency, status FROM "Payment" WHERE id = $1 FOR UPDATE',
                paymentId,
            );

            const payment = payments[0];
            if (!payment) {
                throw new NotFoundException('Payment not found');
            }

            // Xử lý Idempotency: nếu Payment đã SUCCESS trước đó
            if (payment.status === 'SUCCESS') {
                const codSuccessAttempts = await tx.query<{ id: string }>(
                    'SELECT id FROM "PaymentAttempt" WHERE "paymentId" = $1 AND "paymentMethod" = \'COD\' AND status = \'SUCCESS\'',
                    paymentId,
                );

                if (codSuccessAttempts.length > 0) {
                    // xác nhận COD thành công trước đó -> trả về 200, KHÔNG phát event thứ hai
                    return {
                        id: payment.id,
                        orderId: payment.orderId,
                        userId: payment.userId,
                        amount: String(payment.amount).split('.')[0],
                        currency: payment.currency as 'VND',
                        status: 'SUCCESS',
                        paymentUrl: null,
                    };
                }

                // SUCCESS nhưng bằng phương thức khác
                throw new ConflictException('Payment has already succeeded through another method');
            }

            if (payment.status !== 'PENDING') {
                throw new ConflictException(`Payment is in ${payment.status} status and cannot be confirmed`);
            }

            // Tìm attempt COD đang PENDING chưa hết hạn
            const attempts = await tx.query<PaymentAttemptRow>(
                'SELECT id, "paymentId", "paymentMethod", "providerReference", status, "expiresAt" FROM "PaymentAttempt" WHERE "paymentId" = $1 AND "paymentMethod" = \'COD\' AND status = \'PENDING\' FOR UPDATE',
                paymentId,
            );

            const attempt = attempts[0];
            if (!attempt) {
                throw new ConflictException('No pending COD attempt found for this payment');
            }

            const now = new Date();
            if (new Date(attempt.expiresAt) <= now) {
                // hết hạn -> cập nhật EXPIRED và báo 409
                await tx.execute(
                    'UPDATE "PaymentAttempt" SET status = \'EXPIRED\', "updatedAt" = now() WHERE id = $1',
                    attempt.id,
                );
                throw new ConflictException('COD payment attempt has expired');
            }

            // Cập nhật attempt và payment sang SUCCESS
            const transactionId = `COD-${attempt.providerReference}`;

            await tx.execute(
                'UPDATE "PaymentAttempt" SET status = \'SUCCESS\', "transactionId" = $1, "paidAt" = $2::timestamp, "updatedAt" = now() WHERE id = $3',
                transactionId,
                now.toISOString(),
                attempt.id,
            );

            await tx.execute(
                'UPDATE "Payment" SET status = \'SUCCESS\', "paidAt" = $1::timestamp, "updatedAt" = now() WHERE id = $2',
                now.toISOString(),
                payment.id,
            );

            const isUuid = (val?: string) =>
                Boolean(val && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val));

            // Phát sự kiện payment.succeeded vào Outbox cùng transaction
            const event: IntegrationEvent = {
                eventId: randomUUID(),
                eventName: 'payment.succeeded',
                schemaVersion: 1,
                occurredAt: now.toISOString(),
                producer: 'payment',
                aggregateId: payment.id,
                aggregateVersion: 1,
                correlationId: isUuid(correlationId) ? correlationId! : randomUUID(),
                payload: {
                    paymentId: payment.id,
                    orderId: payment.orderId,
                    userId: payment.userId,
                    amount: String(payment.amount).split('.')[0],
                    currency: 'VND',
                    paymentMethod: 'COD',
                    transactionId,
                    paidAt: now.toISOString(),
                },
            };

            await enqueueEvent(tx, event);

            return {
                id: payment.id,
                orderId: payment.orderId,
                userId: payment.userId,
                amount: String(payment.amount).split('.')[0],
                currency: payment.currency as 'VND',
                status: 'SUCCESS',
                paymentUrl: null,
            };
        });
    }
}
