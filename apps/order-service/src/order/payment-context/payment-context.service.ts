import {
    Injectable,
    NotFoundException,
    ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OrderStatus } from '@prisma/client/order/index.js';

export interface PaymentContextResponse {
    orderId: string;
    buyerId: string;
    sellerId: string;
    amount: string;
    currency: 'VND';
    status: 'PENDING_PAYMENT';
}

@Injectable()
export class PaymentContextService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Lấy ngữ cảnh thanh toán của đơn hàng cho payment-service
     * - Order không tồn tại -> 404 NotFound
     * - Trạng thái khác PENDING_PAYMENT -> 409 Conflict
     * - Trả về đúng 6 trường trong schema PaymentContext
     */
    async getPaymentContext(orderId: string): Promise<PaymentContextResponse> {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
        });

        if (!order) {
            throw new NotFoundException('Order not found');
        }

        if (order.status !== OrderStatus.PENDING_PAYMENT) {
            throw new ConflictException(
                `Order is not in PENDING_PAYMENT status (current: ${order.status})`,
            );
        }

        return {
            orderId: order.id,
            buyerId: order.buyerId,
            sellerId: order.sellerId,
            amount: order.totalAmount.toFixed(0),
            currency: 'VND',
            status: 'PENDING_PAYMENT',
        };
    }
}