import { Injectable, BadGatewayException } from '@nestjs/common';
import type {
  ProductReservation as Reservation,
  OrderPaymentContext as PaymentContext,
} from '../contracts/http.generated.js';
@Injectable()
export class InternalHttp {
  async request<T>(
    url: string,
    method: 'GET' | 'PUT',
    key: string,
    correlationId: string,
    body?: unknown,
  ): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, {
          method,
          headers: {
            'content-type': 'application/json',
            'x-service-key': key,
            'x-correlation-id': correlationId,
          },
          ...(method === 'PUT' && body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
          signal: AbortSignal.timeout(3000),
        });
        if ([502, 503, 504].includes(r.status) && attempt === 0) continue;
        if (!r.ok) throw new InternalResponseError(r.status, await r.text());
        return (await r.json()) as T;
      } catch (e) {
        if (e instanceof InternalResponseError) throw e;
        if (attempt === 1)
          throw new BadGatewayException('Internal service unavailable');
      }
    }
    throw new BadGatewayException();
  }
  reserveProduct(
    id: string,
    input: { auctionId: string; sellerId: string },
    correlationId: string,
  ) {
    return this.request<Reservation>(
      `${process.env.PRODUCT_SERVICE_URL}/internal/products/${id}/auction-reservation`,
      'PUT',
      process.env.INTERNAL_AUCTION_KEY!,
      correlationId,
      input,
    );
  }
  paymentContext(id: string, correlationId: string) {
    return this.request<PaymentContext>(
      `${process.env.ORDER_SERVICE_URL}/internal/orders/${id}/payment-context`,
      'GET',
      process.env.INTERNAL_PAYMENT_KEY!,
      correlationId,
    );
  }
}
export class InternalResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
