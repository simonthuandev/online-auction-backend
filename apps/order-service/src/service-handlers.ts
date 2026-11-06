import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import { OrderConsumer } from './order/order.consumer.js';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly orderConsumer: OrderConsumer,
  ) { }
  onModuleInit() {
    // this.http.register('<operationId from contracts/openapi/order.json>', async request => { ... });
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.
    this.events.register('auction.ended', async (tx, event) => {
      await this.orderConsumer.handleAuctionEnded(tx, event);
    });
  }
}
