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
    InternalHttp,
    InternalResponseError,
    withIdempotency,
} from '@app/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { VnpayGateway } from './vnpay.gateway.js';

export interface CreatePaymentInput {
    orderId: string;
    paymentMethod: 'COD' | 'VNPAY';
}

export interface PaymentResponse {
    id: string;
    orderId: string;
    userId: string;
    amount: string;
    currency: 'VND';
    status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'EXPIRED';
    paymentUrl: string | null;
}

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
export class PaymentService {
    constructor(
        @Inject(PLATFORM_DB) private readonly db: Database,
        private readonly prisma: PrismaService,
        private readonly internalHttp: InternalHttp,
        private readonly vnpayGateway: VnpayGateway,
    ) { }

    /**
     * Tạo hoặc tiếp tục phiên thanh toán
     */
    async createPayment(
        body: CreatePaymentInput,
        idempotencyKey: string,
        principal: Principal,
        correlationId: string,
    ): Promise<PaymentResponse> {
        const { orderId, paymentMethod } = body;

        // 1. Gọi Order context BÊN NGOÀI withIdempotency để tránh lock DB > 5s
        let orderContext;
        try {
            orderContext = await this.internalHttp.paymentContext(orderId, correlationId);
        } catch (err) {
            if (err instanceof InternalResponseError) {
                if (err.status === 404) throw new NotFoundException('Order not found');
                if (err.status === 409) {
                    throw new ConflictException('Order is not in PENDING_PAYMENT status');
                }
            }
            throw err;
        }

        // Kiểm tra quyền: Chỉ buyer của đơn hàng mới được tạo thanh toán
        if (orderContext.buyerId !== principal.sub) {
            throw new ForbiddenException('You are not the buyer of this order');
        }

        // 2. Kiểm tra cấu hình VNPAY TRƯỚC KHI tạo attempt vào DB
        if (paymentMethod === 'VNPAY') {
            this.vnpayGateway.buildPaymentUrl({
                id: 'pre-check',
                amount: orderContext.amount,
                providerReference: 'pre-check',
            });
        }

        // 3. Thực hiện trong withIdempotency
        const { response } = await withIdempotency(
            this.db,
            principal.sub,
            'payment_post__api_payments',
            idempotencyKey,
            body,
            201,
            async (tx) => {
                const now = new Date();

                // Kiểm tra Payment đã tồn tại cho orderId này chưa
                const payments = await tx.query<PaymentRow>(
                    'SELECT id, "orderId", "userId", amount::text, currency, status FROM "Payment" WHERE "orderId" = $1 FOR UPDATE',
                    orderId,
                );

                let payment = payments[0];

                if (payment) {
                    // Nếu đã thanh toán thành công -> quăng 409 Conflict
                    if (payment.status === 'SUCCESS') {
                        throw new ConflictException('Payment has already succeeded');
                    }
                } else {
                    // Tạo mới Payment
                    const paymentId = randomUUID();
                    await tx.execute(
                        'INSERT INTO "Payment" (id, "orderId", "userId", amount, currency, status, "updatedAt") VALUES ($1, $2, $3, $4::numeric, $5, \'PENDING\', now())',
                        paymentId,
                        orderContext.orderId,
                        orderContext.buyerId,
                        orderContext.amount,
                        orderContext.currency,
                    );
                    payment = {
                        id: paymentId,
                        orderId: orderContext.orderId,
                        userId: orderContext.buyerId,
                        amount: orderContext.amount,
                        currency: orderContext.currency,
                        status: 'PENDING',
                    };
                }

                // Tìm attempt đang PENDING của Payment này
                const attempts = await tx.query<PaymentAttemptRow>(
                    'SELECT id, "paymentId", "paymentMethod", "providerReference", status, "expiresAt" FROM "PaymentAttempt" WHERE "paymentId" = $1 AND status = \'PENDING\' FOR UPDATE',
                    payment.id,
                );

                let activeAttempt: PaymentAttemptRow | undefined = attempts[0];

                // Lazy expire: Nếu attempt cũ đã quá hạn -> đổi status thành EXPIRED
                if (activeAttempt && new Date(activeAttempt.expiresAt) <= now) {
                    await tx.execute(
                        'UPDATE "PaymentAttempt" SET status = \'EXPIRED\', "updatedAt" = now() WHERE id = $1',
                        activeAttempt.id,
                    );
                    activeAttempt = undefined;
                }

                // Xử lý cùng / khác method theo Quyết định #8
                if (activeAttempt) {
                    if (activeAttempt.paymentMethod !== paymentMethod) {
                        // Khác phương thức khi đang có attempt PENDING -> ném 409 Conflict
                        throw new ConflictException(
                            `A pending payment attempt with method ${activeAttempt.paymentMethod} already exists`,
                        );
                    }
                    // Cùng phương thức: tái sử dụng attempt đang PENDING
                }

                // Nếu chưa có attempt hợp lệ -> Tạo attempt mới
                if (!activeAttempt) {
                    const attemptId = randomUUID();
                    const providerReference = randomUUID().replaceAll('-', '');
                    // Quyết định #8: COD hạn 7 ngày, VNPay 15 phút
                    const durationMs = paymentMethod === 'COD' ? 7 * 24 * 60 * 60 * 1000 : 15 * 60 * 1000;
                    const expiresAt = new Date(Date.now() + durationMs);

                    await tx.execute(
                        'INSERT INTO "PaymentAttempt" (id, "paymentId", "paymentMethod", "providerReference", status, "expiresAt", "updatedAt") VALUES ($1, $2, $3::"PaymentMethod", $4, \'PENDING\', $5::timestamp, now())',
                        attemptId,
                        payment.id,
                        paymentMethod,
                        providerReference,
                        expiresAt.toISOString(),
                    );

                    activeAttempt = {
                        id: attemptId,
                        paymentId: payment.id,
                        paymentMethod,
                        providerReference,
                        status: 'PENDING',
                        expiresAt,
                    };
                }

                // Xử lý paymentUrl
                let paymentUrl: string | null = null;
                if (paymentMethod === 'VNPAY') {
                    paymentUrl = this.vnpayGateway.buildPaymentUrl({
                        id: activeAttempt.id,
                        amount: String(payment.amount).split('.')[0],
                        providerReference: activeAttempt.providerReference,
                    });
                }

                return {
                    id: payment.id,
                    orderId: payment.orderId,
                    userId: payment.userId,
                    amount: String(payment.amount).split('.')[0],
                    currency: payment.currency as 'VND',
                    status: payment.status,
                    paymentUrl,
                };
            },
        );

        return response;
    }

    /**
     * Lấy thông tin thanh toán theo orderId
     */
    async getPaymentByOrderId(orderId: string, principal: Principal): Promise<PaymentResponse> {
        const payment = await this.prisma.payment.findUnique({
            where: { orderId },
            include: {
                attempts: {
                    where: { status: 'PENDING' },
                    orderBy: { createdAt: 'desc' },
                    take: 1,
                },
            },
        });

        if (!payment) {
            throw new NotFoundException('Payment not found');
        }

        // Chỉ người mua hoặc ADMIN mới có quyền xem
        if (payment.userId !== principal.sub && principal.role !== 'ADMIN') {
            throw new ForbiddenException('Forbidden: You do not have access to this payment');
        }

        // Quyết định #8: Lazy expire khi đọc
        let pendingAttempt = payment.attempts[0];
        if (pendingAttempt && new Date(pendingAttempt.expiresAt) <= new Date()) {
            await this.prisma.paymentAttempt.update({
                where: { id: pendingAttempt.id },
                data: { status: 'EXPIRED' },
            });
            pendingAttempt = undefined as any;
        }

        let paymentUrl: string | null = null;
        if (
            pendingAttempt &&
            pendingAttempt.paymentMethod === 'VNPAY' &&
            this.vnpayGateway.isConfigured()
        ) {
            paymentUrl = this.vnpayGateway.buildPaymentUrl({
                id: pendingAttempt.id,
                amount: payment.amount.toFixed(0),
                providerReference: pendingAttempt.providerReference,
            });
        }

        return {
            id: payment.id,
            orderId: payment.orderId,
            userId: payment.userId,
            amount: payment.amount.toFixed(0),
            currency: payment.currency as 'VND',
            status: payment.status,
            paymentUrl,
        };
    }
}
