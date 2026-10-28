import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import {
  document,
  validator,
  validateEvent,
} from '../libs/common/src/platform/contracts.js';
import {
  AccessTokens,
  constantEqual,
} from '../libs/common/src/platform/security.js';
import {
  InternalHttp,
  InternalResponseError,
} from '../libs/common/src/platform/internal-http.js';
import { RMQ_BINDINGS } from '../libs/common/src/constants/rmq.constant.js';
import { afterEach, describe, it, expect, vi } from 'vitest';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const path = mkdtempSync(join(tmpdir(), 'auction-keys-'));
writeFileSync(join(path, 'public.pem'), keys.publicKey);
process.env.JWT_PUBLIC_KEY_PATH = join(path, 'public.pem');
process.env.JWT_ISSUER = 'online-auction';
process.env.JWT_AUDIENCE = 'online-auction-api';
const jwt = new JwtService();
const sign = (payload: object, expiresIn: number = 60) =>
  jwt.sign(payload, {
    privateKey: keys.privateKey,
    algorithm: 'RS256',
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    expiresIn,
  });
afterEach(() => vi.unstubAllGlobals());
describe('access-token trust boundary', () => {
  it('rejects forged identity headers and wrong roles', () => {
    const tokens = new AccessTokens();
    expect(() => tokens.authorize(undefined)).toThrow();
    const token = sign({ sub: randomUUID(), type: 'access', role: 'USER' });
    expect(() => tokens.authorize('Bearer ' + token, ['ADMIN'])).toThrow();
    expect(tokens.authorize('Bearer ' + token).role).toBe('USER');
  });
  it('rejects wrong token type, expired token and HMAC substitution', () => {
    const t = new AccessTokens();
    for (const token of [
      sign({ sub: randomUUID(), type: 'refresh', role: 'ADMIN' }),
      sign({ sub: randomUUID(), type: 'access', role: 'ADMIN' }, -1),
      jwt.sign(
        { sub: randomUUID(), role: 'ADMIN', type: 'access' },
        { secret: 'forged', algorithm: 'HS256' },
      ),
    ])
      expect(() => t.verify(token)).toThrow();
  });
  it('requires a configured matching internal credential', () => {
    expect(constantEqual('x', undefined)).toBe(false);
    expect(constantEqual(['secret'], 'secret')).toBe(false);
    expect(constantEqual('wrong', 'secret')).toBe(false);
    expect(constantEqual('secret', 'secret')).toBe(true);
  });
});
describe('contracts', () => {
  it('validates payment event methods, money and unknown fields', () => {
    const id = randomUUID();
    const event = {
      eventId: id,
      eventName: 'payment.succeeded',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      producer: 'payment',
      aggregateId: id,
      aggregateVersion: 1,
      correlationId: id,
      payload: {
        paymentId: id,
        orderId: id,
        userId: id,
        amount: '100000',
        currency: 'VND',
        paymentMethod: 'COD',
        transactionId: id,
        paidAt: new Date().toISOString(),
      },
    };
    expect(() => validateEvent(event)).not.toThrow();
    expect(() =>
      validateEvent({
        ...event,
        payload: { ...event.payload, paymentMethod: 'VNPAY' },
      }),
    ).not.toThrow();
    expect(() =>
      validateEvent({
        ...event,
        payload: { ...event.payload, amount: 100000 },
      }),
    ).toThrow();
    expect(() => validateEvent({ ...event, invented: true })).toThrow();
  });
  it('accepts only COD and VNPAY when requesting payment', () => {
    const doc = document('payment');
    const schema =
      doc.paths['/api/payments'].post.requestBody!.content['application/json']
        .schema;
    const check = validator(schema, doc);
    const orderId = randomUUID();
    for (const paymentMethod of ['COD', 'VNPAY'])
      expect(check({ orderId, paymentMethod })).toBe(true);
    // These are invalid inputs, not additional supported payment methods.
    for (const paymentMethod of ['CASH', '', null])
      expect(check({ orderId, paymentMethod })).toBe(false);
  });
  it('gives each consumer its own fan-out queue', () => {
    const queues = RMQ_BINDINGS.filter((x) =>
      x.bindings.some(
        ([exchange, key]) =>
          exchange === 'auction_exchange' && key === 'auction.ended',
      ),
    ).map((x) => x.queue);
    expect(new Set(queues).size).toBe(3);
  });
  it('defines validation, security and placeholder responses for every operation', () => {
    for (const service of [
      'auth',
      'product',
      'auction',
      'order',
      'payment',
      'notification',
    ]) {
      const doc = document(service);
      for (const ops of Object.values(doc.paths))
        for (const op of Object.values(ops)) {
          expect(op['x-auth']).toMatch(/^(public|internal|bearer)$/);
          expect(op.responses['501']).toBeDefined();
          if (op.requestBody)
            expect(() =>
              validator(
                op.requestBody!.content['application/json'].schema,
                doc,
              ),
            ).not.toThrow();
        }
    }
  });
});
describe('internal HTTP failure policy', () => {
  it('retries transient failures once with the same body and correlation ID', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    expect(
      await new InternalHttp().request(
        'http://product/internal',
        'PUT',
        'key',
        'correlation',
        { auctionId: 'a' },
      ),
    ).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toEqual(fetch.mock.calls[1][0]);
    expect(fetch.mock.calls[0][1].headers).toEqual(
      fetch.mock.calls[1][1].headers,
    );
    expect(fetch.mock.calls[0][1].body).toEqual(fetch.mock.calls[1][1].body);
  });
  it('does not retry business conflicts', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('conflict', { status: 409 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      new InternalHttp().request(
        'http://product/internal',
        'PUT',
        'key',
        'correlation',
        {},
      ),
    ).rejects.toBeInstanceOf(InternalResponseError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
