import {
    Injectable,
    NotFoundException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
    OrderStatus,
    type Order,
    type Prisma,
} from '@prisma/client/order/index.js';

export interface ListOrdersQuery {
    page?: unknown;
    pageSize?: unknown;
    status?: unknown;
}

export interface OrderResponse {
    id: string;
    auctionId: string;
    productId: string;
    buyerId: string;
    sellerId: string;
    totalAmount: string;
    currency: 'VND';
    status: OrderStatus;
    productTitle: string;
    productThumbnail: string | null;
}

export interface OrderPageResponse {
    items: OrderResponse[];
    page: number;
    pageSize: number;
    total: number;
}

@Injectable()
export class OrderQueryService {
    constructor(private readonly prisma: PrismaService) { }

    /**
     * Lấy danh sách đơn hàng của người dùng hiện tại (là buyer hoặc seller)
     * - Lọc: buyerId = userId OR sellerId = userId
     * - Lọc status nếu có (nếu status sai -> quăng 400 BadRequest)
     * - Phân trang & sắp xếp createdAt desc
     */
    async listOrders(
        userId: string,
        query: ListOrdersQuery,
    ): Promise<OrderPageResponse> {
        const page = Math.max(1, Number(query.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));

        const where: Prisma.OrderWhereInput = {
            OR: [{ buyerId: userId }, { sellerId: userId }],
        };

        // Kiểm tra và lọc theo status nếu có truyền vào
        if (
            query.status !== undefined &&
            query.status !== null &&
            query.status !== ''
        ) {
            if (typeof query.status !== 'string') {
                throw new BadRequestException('Invalid order status');
            }
            const statusStr = query.status;
            if (!Object.values(OrderStatus).includes(statusStr as OrderStatus)) {
                throw new BadRequestException(`Invalid order status: ${statusStr}`);
            }
            where.status = statusStr as OrderStatus;
        }

        const [orders, total] = await Promise.all([
            this.prisma.order.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            this.prisma.order.count({ where }),
        ]);

        return {
            items: orders.map(mapOrderToResponse),
            page,
            pageSize,
            total,
        };
    }

    /**
     * Xem chi tiết đơn hàng:
     * - Nếu không tồn tại: 404 Not Found
     * - Nếu người gọi KHÔNG PHẢI buyer và KHÔNG PHẢI seller: 404 Not Found (để không lộ sự tồn tại của đơn)
     */
    async getOrderById(userId: string, orderId: string): Promise<OrderResponse> {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
        });

        if (!order || (order.buyerId !== userId && order.sellerId !== userId)) {
            throw new NotFoundException('Order not found');
        }

        return mapOrderToResponse(order);
    }
}

/**
 * Format dữ liệu trả về theo đúng chuẩn OpenAPI:
 * - totalAmount được chuyển đổi thành chuỗi số nguyên đồng (string)
 */
export function mapOrderToResponse(order: Order): OrderResponse {
    return {
        id: order.id,
        auctionId: order.auctionId,
        productId: order.productId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        totalAmount: order.totalAmount.toFixed(0),
        currency: 'VND',
        status: order.status,
        productTitle: order.productTitle,
        productThumbnail: order.productThumbnail ?? null,
    };
}
