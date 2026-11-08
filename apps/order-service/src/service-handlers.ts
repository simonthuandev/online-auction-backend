import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import { OrderConsumer } from './order/order.consumer.js';
import { PaymentContextService } from './order/payment-context/payment-context.service.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly orderConsumer: OrderConsumer,
    private readonly paymentContext: PaymentContextService,
  ) { }
  onModuleInit() {
    // this.http.register('<operationId from contracts/openapi/order.json>', async request => { ... });
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.
    this.events.register('auction.ended', async (tx, event) => {
      await this.orderConsumer.handleAuctionEnded(tx, event);
    });

    // [GET] /internal/orders/{id}/payment-context (ORDER-03)
    this.http.register('order_get__internal_orders_id_payment-context', async (request) => {
      const orderId = String(request.params.id);
      return this.paymentContext.getPaymentContext(orderId);
    });
  }
}
