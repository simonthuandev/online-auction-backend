import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFileSync, mkdirSync } from 'node:fs';
import { io } from 'socket.io-client';
import amqp from 'amqplib';
import pg from 'pg';
import { Ajv } from 'ajv';
import formats from 'ajv-formats';
import { loadEnv, services } from './env.mjs';
import { documents } from './catalog.mjs';
loadEnv();
const report = [];
const base = `http://localhost:${process.env.API_GATEWAY_PORT || 8080}`;
const direct = (s) =>
  `http://localhost:${process.env[s.toUpperCase() + '_PORT']}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  let error;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      error = e;
    }
    await sleep(200);
  }
  throw Error(`Timed out: ${label}; ${error?.message || ''}`);
}
async function test(name, fn) {
  const start = Date.now();
  await fn();
  report.push({ name, status: 'PASS', durationMs: Date.now() - start });
  console.log('PASS ' + name);
}
async function request(url, method = 'GET', body, headers = {}) {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}
const adminHeaders = { 'x-service-key': process.env.PLATFORM_ADMIN_KEY };
const sockets = [];
let connection;
try {
  await test('six services and gateway ready', async () => {
    for (const s of services) {
      await until(
        async () => {
          const r = await request(direct(s) + '/health/ready');
          return r.status === 200;
        },
        s + ' health',
        90000,
      );
      await until(
        async () => {
          const r = await request(base + `/api/${s}/health`);
          return r.status === 200;
        },
        'gateway ' + s + ' health',
        30000,
      );
    }
  });
  if (!process.argv.includes('--health')) {
    const tokens = {};
    for (const role of ['admin', 'seller', 'bidder']) {
      const r = await request(base + '/api/auth/login', 'POST', {
        email: role + '@auction.test',
        password: process.env.SEED_PASSWORD,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      tokens[role] = r.data;
    }
    await test('RS256, refresh rotation, reuse and logout', async () => {
      assert.equal(
        JSON.parse(
          Buffer.from(tokens.bidder.accessToken.split('.')[0], 'base64url'),
        ).alg,
        'RS256',
      );
      const bad = await request(base + '/api/orders', 'GET', undefined, {
        'x-user-id': randomUUID(),
        'x-user-role': 'ADMIN',
      });
      assert.equal(bad.status, 401);
      const refreshed = await request(base + '/api/auth/refresh', 'POST', {
        refreshToken: tokens.bidder.refreshToken,
      });
      assert.equal(refreshed.status, 200);
      assert.notEqual(refreshed.data.refreshToken, tokens.bidder.refreshToken);
      const reused = await request(base + '/api/auth/refresh', 'POST', {
        refreshToken: tokens.bidder.refreshToken,
      });
      assert.equal(reused.status, 401);
      const revoked = await request(base + '/api/auth/refresh', 'POST', {
        refreshToken: refreshed.data.refreshToken,
      });
      assert.equal(revoked.status, 401);
      const logout = await request(base + '/api/auth/logout', 'POST', {
        refreshToken: tokens.seller.refreshToken,
      });
      assert.equal(logout.status, 200);
      assert.equal(
        (
          await request(base + '/api/auth/refresh', 'POST', {
            refreshToken: tokens.seller.refreshToken,
          })
        ).status,
        401,
      );
    });
    const ajv = new Ajv({ strict: false, allowUnionTypes: true });
    formats(ajv);
    function sample(schema, doc) {
      if (schema.$ref)
        return sample(
          doc.components.schemas[schema.$ref.split('/').at(-1)],
          doc,
        );
      if ('const' in schema) return schema.const;
      if (schema.enum) return schema.enum[0];
      if (schema.anyOf) return sample(schema.anyOf[0], doc);
      if (Array.isArray(schema.type))
        return sample(
          { ...schema, type: schema.type.find((t) => t !== 'null') },
          doc,
        );
      if (schema.type === 'object')
        return Object.fromEntries(
          (schema.required || []).map((k) => [
            k,
            sample(schema.properties[k], doc),
          ]),
        );
      if (schema.type === 'array') return [];
      if (schema.type === 'integer' || schema.type === 'number')
        return schema.minimum || 1;
      if (schema.type === 'boolean') return false;
      if (schema.format === 'uuid') return randomUUID();
      if (schema.format === 'date-time')
        return new Date(Date.now() + 60000).toISOString();
      if (schema.format === 'email') return randomUUID() + '@auction.test';
      if (schema.format === 'uri') return 'https://example.com/image.jpg';
      if (schema.pattern) return '100000';
      return 'fixture-value';
    }
    await test('every gateway route forwards to its contract handler', async () => {
      for (const doc of documents())
        for (const [path, ops] of Object.entries(doc.paths))
          for (const [method, op] of Object.entries(ops)) {
            if (
              op['x-auth'] === 'internal' ||
              op['x-implementation'] === 'completed'
            )
              continue;
            const who = op['x-roles']?.includes('ADMIN')
              ? 'admin'
              : op['x-roles']?.includes('SELLER')
                ? 'seller'
                : 'bidder';
            const headers = {
              authorization: 'Bearer ' + tokens[who].accessToken,
              'idempotency-key': randomUUID(),
            };
            const body = op.requestBody
              ? sample(op.requestBody.content['application/json'].schema, doc)
              : undefined;
            const r = await request(
              base + path.replace(/\{[^}]+\}/g, () => randomUUID()),
              method.toUpperCase(),
              body,
              headers,
            );
            assert.equal(
              r.status,
              501,
              `${method} ${path}: ${JSON.stringify(r.data)}`,
            );
            const check = ajv.compile({
              ...doc.components.schemas.Error,
              components: doc.components,
            });
            assert(check(r.data), JSON.stringify(check.errors));
          }
    });
    await test('validation and role enforcement through gateway', async () => {
      const paymentHeaders = {
        authorization: 'Bearer ' + tokens.bidder.accessToken,
        'idempotency-key': randomUUID(),
      };
      for (const paymentMethod of ['COD', 'VNPAY']) {
        const r = await request(
          base + '/api/payments',
          'POST',
          {
            orderId: randomUUID(),
            paymentMethod,
          },
          paymentHeaders,
        );
        assert.equal(
          r.status,
          501,
          `${paymentMethod}: ${JSON.stringify(r.data)}`,
        );
      }
      assert.equal(
        (
          await request(
            base + '/api/products',
            'POST',
            {},
            { authorization: 'Bearer ' + tokens.seller.accessToken },
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await request(
            base + '/api/categories',
            'POST',
            { name: 'test' },
            { authorization: 'Bearer ' + tokens.bidder.accessToken },
          )
        ).status,
        403,
      );
      assert.equal(
        (await request(base + '/api/products?pageSize=101')).status,
        400,
      );
      assert.equal(
        (
          await request(
            base +
              '/internal/products/' +
              randomUUID() +
              '/auction-reservation',
            'PUT',
            {},
          )
        ).status,
        404,
      );
    });
    const runId = randomUUID();
    await test('Redis isolation and TTL for all services', async () => {
      for (const s of services) {
        const r = await request(
          direct(s) + '/_platform/probe',
          'POST',
          { runId, kind: 'redis' },
          adminHeaders,
        );
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.data.value, runId);
        assert(r.data.data.ttl > 0);
      }
    });
    await test('real internal REST clients and internal credentials', async () => {
      for (const s of ['auction', 'payment']) {
        const r = await request(
          direct(s) + '/_platform/probe',
          'POST',
          { runId, kind: 'rest' },
          adminHeaders,
        );
        assert.equal(r.status, 200, JSON.stringify(r.data));
      }
      assert.equal(
        (
          await request(
            direct('order') +
              '/internal/orders/' +
              randomUUID() +
              '/payment-context',
          )
        ).status,
        401,
      );
    });
    await test('database credentials are isolated', async () => {
      const url = new URL(process.env.PRODUCT_DATABASE_URL);
      url.pathname = '/order_db';
      const client = new pg.Client({ connectionString: url.toString() });
      try {
        await assert.rejects(() => client.connect());
      } finally {
        await client.end().catch(() => {});
      }
    });
    const bidUser = '10000000-0000-4000-8000-000000000003';
    const auctionId = runId;
    const messages = [];
    await test('authenticated socket rooms and invalid token rejection', async () => {
      for (const [s, namespace] of [
        ['auction', 'auctions'],
        ['notification', 'notifications'],
      ]) {
        const socket = io(direct(s) + '/' + namespace, {
          transports: ['websocket'],
          auth: { token: tokens.bidder.accessToken },
          reconnection: false,
        });
        sockets.push(socket);
        await Promise.race([
          once(socket, 'connect'),
          once(socket, 'connect_error').then(([e]) => Promise.reject(e)),
          sleep(5000).then(() => {
            throw Error('socket timeout');
          }),
        ]);
        socket.onAny((name, payload) => messages.push({ name, payload }));
      }
      const ack = await sockets[0]
        .timeout(3000)
        .emitWithAck('auction:subscribe', { auctionId });
      assert.equal(ack.ok, true);
      sockets[0].emit('auction:subscribe', { auctionId }, { invalidAck: true });
      const again = await sockets[0]
        .timeout(3000)
        .emitWithAck('auction:subscribe', { auctionId });
      assert.equal(again.ok, true);
      const invalid = io(direct('notification') + '/notifications', {
        transports: ['websocket'],
        auth: { token: 'invalid' },
        reconnection: false,
      });
      sockets.push(invalid);
      await once(invalid, 'connect_error');
      assert(!invalid.connected);
    });
    const timestamp = new Date().toISOString();
    const pid = '20000000-0000-4000-8000-000000000001';
    const seller = '10000000-0000-4000-8000-000000000002';
    const payloads = {
      'auction.started': {
        auctionId,
        productId: pid,
        sellerId: seller,
        startTime: timestamp,
        endTime: new Date(Date.now() + 60000).toISOString(),
      },
      'bid.placed': {
        auctionId,
        productId: pid,
        productTitle: 'Demo product',
        newBidderId: seller,
        previousBidderId: bidUser,
        currentPrice: '100000',
        currency: 'VND',
        bidTime: timestamp,
      },
      'auction.ended': {
        auctionId,
        productId: pid,
        productTitle: 'Demo product',
        productThumbnail: null,
        sellerId: seller,
        winnerId: bidUser,
        finalPrice: '100000',
        currency: 'VND',
        endedAt: timestamp,
      },
      'payment.succeeded': {
        paymentId: randomUUID(),
        orderId: randomUUID(),
        userId: bidUser,
        amount: '100000',
        currency: 'VND',
        paymentMethod: 'COD',
        transactionId: randomUUID(),
        paidAt: timestamp,
      },
    };
    const events = Object.entries(payloads).map(([name, payload], i) => ({
      eventId: randomUUID(),
      eventName: name,
      schemaVersion: 1,
      occurredAt: timestamp,
      producer: name.startsWith('payment') ? 'payment' : 'auction',
      aggregateId: name.startsWith('payment') ? payload.paymentId : auctionId,
      aggregateVersion: name.startsWith('payment') ? 1 : i + 1,
      correlationId: runId,
      payload,
      demo: { runId },
    }));
    await test('transactional outbox fan-out and socket delivery', async () => {
      for (const event of events) {
        const r = await request(
          direct(event.producer) + '/_platform/events',
          'POST',
          event,
          adminHeaders,
        );
        assert.equal(r.status, 202, JSON.stringify(r.data));
      }
      const expected = {
        product: ['auction.started', 'auction.ended'],
        order: ['auction.ended', 'payment.succeeded'],
        notification: ['bid.placed', 'auction.ended', 'payment.succeeded'],
      };
      for (const [s, kinds] of Object.entries(expected))
        await until(async () => {
          const r = await request(
            direct(s) + '/_platform/probes/' + runId,
            'GET',
            undefined,
            adminHeaders,
          );
          return kinds.every((k) => r.data.some((v) => v.kind === k));
        }, s + ' event fan-out');
      await until(
        () =>
          messages.some((v) => v.name === 'auction:bid_updated') &&
          messages.filter((v) => v.name === 'notification:new').length >= 3,
        'socket emissions',
      );
    });
    connection = await amqp.connect(process.env.RABBITMQ_URL);
    const ch = await connection.createConfirmChannel();
    await test('duplicate events have no duplicate effects', async () => {
      for (let i = 0; i < 3; i++)
        ch.publish(
          'auction_exchange',
          'auction.ended',
          Buffer.from(JSON.stringify(events[2])),
          { persistent: true },
        );
      await ch.waitForConfirms();
      await sleep(500);
      for (const s of ['product', 'order', 'notification']) {
        const r = await request(
          direct(s) + '/_platform/probes/' + runId,
          'GET',
          undefined,
          adminHeaders,
        );
        assert.equal(
          r.data.filter((v) => v.kind === 'auction.ended').length,
          1,
        );
      }
    });
    await test('transient consumer error retries then commits', async () => {
      const retryRun = randomUUID();
      await request(
        direct('order') + '/_platform/probe',
        'POST',
        {
          runId: retryRun,
          kind: 'fault',
          eventName: 'auction.ended',
          remaining: 2,
        },
        adminHeaders,
      );
      const event = {
        ...events[2],
        eventId: randomUUID(),
        aggregateId: retryRun,
        correlationId: retryRun,
        demo: { runId: retryRun },
      };
      ch.publish(
        'auction_exchange',
        'auction.ended',
        Buffer.from(JSON.stringify(event)),
        { persistent: true },
      );
      await ch.waitForConfirms();
      await until(
        async () => {
          const r = await request(
            direct('order') + '/_platform/probes/' + retryRun,
            'GET',
            undefined,
            adminHeaders,
          );
          return r.data.some((v) => v.kind === 'auction.ended');
        },
        'retry delivery',
        25000,
      );
    });
    await test('invalid event goes to DLQ', async () => {
      const before = await ch.checkQueue('queue.order.events.dlq');
      ch.publish('auction_exchange', 'auction.ended', Buffer.from('{invalid'), {
        persistent: true,
      });
      await ch.waitForConfirms();
      await until(
        async () =>
          (await ch.checkQueue('queue.order.events.dlq')).messageCount >
          before.messageCount,
        'DLQ',
      );
    });
    await ch.close();
  }
} finally {
  for (const socket of sockets) socket.close();
  await connection?.close();
  mkdirSync('.local', { recursive: true });
  writeFileSync(
    '.local/smoke-report.json',
    JSON.stringify(
      {
        at: new Date().toISOString(),
        scope: 'Platform connectivity only; domain handlers remain 501',
        checks: report,
      },
      null,
      2,
    ) + '\n',
  );
}
console.log(`Completed ${report.length} platform checks.`);
