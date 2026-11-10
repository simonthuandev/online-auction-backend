import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { HttpHandlers, EventHandlers } from '@app/common';
import { PaymentService } from './payment/payment.service.js';
/** Register service-owned business handlers here; infrastructure is already wired. */
@Injectable()
export class ServiceHandlers implements OnModuleInit {
  constructor(
    private readonly http: HttpHandlers,
    private readonly events: EventHandlers,
    private readonly paymentService: PaymentService,
  ) { }
  onModuleInit() {
    // this.http.register('<operationId from contracts/openapi/payment.json>', async request => { ... });
    // this.events.register('auction.ended', async (tx, event) => { ... });
    // Event writes must use the supplied transaction, not an independent Prisma transaction.

    // [POST] /api/payments (PAY-02)
    this.http.register('payment_post__api_payments', async (request) => {
      const idempotencyKey = String(request.headers['idempotency-key'] || '');
      if (!idempotencyKey) {
        throw new BadRequestException('Idempotency-Key header is required');
      }
      const principal = request.principal!;
      const correlationId = request.requestId;
      const body = request.body as { orderId: string; paymentMethod: 'COD' | 'VNPAY' };
      return this.paymentService.createPayment(
        body,
        idempotencyKey,
        principal,
        correlationId,
      );
    });

    // [GET] /api/payments/order/{orderId} (PAY-02)
    this.http.register('payment_get__api_payments_order_orderId', async (request) => {
      const orderId = String(request.params.orderId);
      const principal = request.principal!;
      return this.paymentService.getPaymentByOrderId(orderId, principal);
    });
  }
}
