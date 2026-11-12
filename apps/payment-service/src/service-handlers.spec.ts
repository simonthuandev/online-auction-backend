import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventHandlers, HttpHandlers } from '@app/common';
import { BadRequestException } from '@nestjs/common';
import { ServiceHandlers } from './service-handlers.js';
import { PaymentService } from './payment/payment.service.js';
import { CodService } from './payment/cod/cod.service.js';

type TestRequest = {
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  requestId?: string;
  principal?: { sub: string; role: string };
};

describe('Payment HTTP handlers', () => {
  const registered = new Map<
    string,
    (request: TestRequest) => Promise<unknown>
  >();

  const http = {
    register: vi.fn(
      (
        operationId: string,
        handler: (request: TestRequest) => Promise<unknown>,
      ) => registered.set(operationId, handler),
    ),
  };

  const paymentService = {
    createPayment: vi.fn(),
    getPaymentByOrderId: vi.fn(),
  };

  const codService = {
    confirmCodPayment: vi.fn(),
  };

  beforeEach(() => {
    registered.clear();
    vi.clearAllMocks();
    new ServiceHandlers(
      http as unknown as HttpHandlers,
      {} as EventHandlers,
      paymentService as unknown as PaymentService,
      codService as unknown as CodService,
    ).onModuleInit();
  });

  it('registers payment creation, order payment query, and COD confirmation operations from contract', () => {
    expect(
      [
        'payment_post__api_payments',
        'payment_get__api_payments_order_orderId',
        'payment_post__api_payments_id_cod_confirm',
      ].every((operationId) => registered.has(operationId)),
    ).toBe(true);
  });

  it('throws BadRequestException if Idempotency-Key header is missing on POST /api/payments', async () => {
    const handler = registered.get('payment_post__api_payments');
    if (!handler) throw new Error('Handler not registered');

    await expect(
      handler({
        params: {},
        query: {},
        headers: {},
        body: { orderId: 'ord-1', paymentMethod: 'COD' },
        principal: { sub: 'buyer-1', role: 'USER' },
        requestId: 'req-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('delegates payment_post__api_payments to paymentService.createPayment', async () => {
    const handler = registered.get('payment_post__api_payments');
    if (!handler) throw new Error('Handler not registered');

    paymentService.createPayment.mockResolvedValue({
      id: 'pay-1',
      orderId: 'ord-1',
      userId: 'buyer-1',
      amount: '200000',
      currency: 'VND',
      status: 'PENDING',
      paymentUrl: null,
    });

    const body = { orderId: 'ord-1', paymentMethod: 'COD' as const };
    const principal = { sub: 'buyer-1', role: 'USER' };
    await handler({
      params: {},
      query: {},
      headers: { 'idempotency-key': 'idem-key-1' },
      body,
      principal,
      requestId: 'req-1',
    });

    expect(paymentService.createPayment).toHaveBeenCalledWith(
      body,
      'idem-key-1',
      principal,
      'req-1',
    );
  });

  it('delegates payment_get__api_payments_order_orderId to paymentService.getPaymentByOrderId', async () => {
    const handler = registered.get('payment_get__api_payments_order_orderId');
    if (!handler) throw new Error('Handler not registered');

    paymentService.getPaymentByOrderId.mockResolvedValue({
      id: 'pay-1',
      orderId: 'ord-1',
      userId: 'buyer-1',
      amount: '200000',
      currency: 'VND',
      status: 'PENDING',
      paymentUrl: null,
    });

    const principal = { sub: 'buyer-1', role: 'USER' };
    await handler({
      params: { orderId: 'ord-1' },
      query: {},
      headers: {},
      body: {},
      principal,
    });

    expect(paymentService.getPaymentByOrderId).toHaveBeenCalledWith(
      'ord-1',
      principal,
    );
  });

  it('delegates payment_post__api_payments_id_cod_confirm to codService.confirmCodPayment', async () => {
    const handler = registered.get('payment_post__api_payments_id_cod_confirm');
    if (!handler) throw new Error('Handler not registered');

    codService.confirmCodPayment.mockResolvedValue({
      id: 'pay-1',
      orderId: 'ord-1',
      userId: 'buyer-1',
      amount: '200000',
      currency: 'VND',
      status: 'SUCCESS',
      paymentUrl: null,
    });

    const principal = { sub: 'admin-1', role: 'ADMIN' };
    await handler({
      params: { id: 'pay-1' },
      query: {},
      headers: {},
      body: {},
      principal,
      requestId: 'req-corr-1',
    });

    expect(codService.confirmCodPayment).toHaveBeenCalledWith(
      'pay-1',
      principal,
      'req-corr-1',
    );
  });
});
