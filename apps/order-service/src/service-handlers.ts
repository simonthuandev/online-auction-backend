import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import { OrderConsumer } from './order/order.consumer.js';
import { OrderQueryService } from './order/query/order-query.service.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly orderConsumer: OrderConsumer,
    private readonly orderQuery: OrderQueryService,
  ) { }
  onModuleInit() {
    // this.http.register('<operationId from contracts/openapi/order.json>', async request => { ... });
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.
    this.events.register('auction.ended', async (tx, event) => {
      await this.orderConsumer.handleAuctionEnded(tx, event);
    });

    // [GET] /api/orders (ORDER-02)
    this.http.register('order_get__api_orders', async (request) => {
      const userId = request.principal!.sub;
      return this.orderQuery.listOrders(userId, {
        page: request.query.page,
        pageSize: request.query.pageSize,
        status: request.query.status,
      });
    });

    // [GET] /api/orders/{id} (ORDER-02)
    this.http.register('order_get__api_orders_id', async (request) => {
      const userId = request.principal!.sub;
      const orderId = String(request.params.id);
      return this.orderQuery.getOrderById(userId, orderId);
    });
  }
}
