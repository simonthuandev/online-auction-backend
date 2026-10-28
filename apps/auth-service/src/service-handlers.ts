import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';

/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
  ) {}
  onModuleInit() {
    // this.http.register('<operationId from contracts/openapi/auth.json>', async request => { ... });
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.
  }
}
