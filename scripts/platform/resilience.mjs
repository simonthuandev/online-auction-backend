import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import amqp from 'amqplib';
import { loadEnv } from './env.mjs';
loadEnv();
const project = process.env.PLATFORM_TEST_PROJECT;
if (
  !project ||
  !/^[a-z0-9-]*(verify|test)[a-z0-9-]*$/.test(project) ||
  !process.env.PLATFORM_ENV_FILE
)
  throw Error(
    'Requires an explicitly isolated PLATFORM_TEST_PROJECT containing verify/test and PLATFORM_ENV_FILE. Never run against a personal database.',
  );
const compose = [
  'compose',
  '--env-file',
  process.env.PLATFORM_ENV_FILE,
  '-p',
  project,
];
function docker(args) {
  const r = spawnSync('docker', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) throw Error(r.stderr || r.stdout);
  return r.stdout.trim();
}
const base = (s) =>
  `http://127.0.0.1:${process.env[s.toUpperCase() + '_PORT']}`;
const headers = {
  'content-type': 'application/json',
  'x-service-key': process.env.PLATFORM_ADMIN_KEY,
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {}
    await delay(250);
  }
  throw Error('Timed out: ' + label);
}
async function request(s, path, body) {
  const r = await fetch(base(s) + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  assert(r.ok, `${s} ${path} ${r.status}`);
  return r.json();
}
function event(name = 'auction.ended') {
  const id = randomUUID(),
    now = new Date().toISOString();
  return {
    eventId: randomUUID(),
    eventName: name,
    schemaVersion: 1,
    occurredAt: now,
    producer: 'auction',
    aggregateId: id,
    aggregateVersion: 1,
    correlationId: id,
    demo: { runId: id },
    payload: {
      auctionId: id,
      productId: randomUUID(),
      productTitle: 'Recovery fixture',
      productThumbnail: null,
      sellerId: '10000000-0000-4000-8000-000000000002',
      winnerId: '10000000-0000-4000-8000-000000000003',
      finalPrice: '100000',
      currency: 'VND',
      endedAt: now,
    },
  };
}
const observed = async (s, e) =>
  (await request(s, '/_platform/probes/' + e.demo.runId)).some(
    (p) => p.kind === e.eventName,
  );
const checks = [];
async function test(name, fn) {
  await fn();
  console.log('PASS ' + name);
  checks.push({ name, status: 'PASS' });
}
const replica = project + '-auction-replica';
const replicaPort = Number(process.env.PLATFORM_REPLICA_PORT || 13013);
let connection;
const sockets = [];
let replicaCreated = false;
try {
  await test('consumer outage retains event and processes on restart', async () => {
    docker([...compose, 'stop', 'order-service']);
    const e = event();
    try {
      await request('auction', '/_platform/events', e);
      await delay(1000);
    } finally {
      docker([...compose, 'start', 'order-service']);
    }
    await until(() => observed('order', e), 'Order catch-up');
  });
  await test('broker outage retains committed outbox and resumes', async () => {
    docker([...compose, 'stop', 'rabbitmq']);
    const e = event();
    try {
      await request('auction', '/_platform/events', e);
      assert.equal(
        (await request('auction', '/health/ready')).status,
        'degraded',
      );
    } finally {
      docker([...compose, 'start', 'rabbitmq']);
    }
    await until(
      () => observed('order', e),
      'Outbox after broker recovery',
      60000,
    );
  });
  connection = await amqp.connect(process.env.RABBITMQ_URL);
  const ch = await connection.createConfirmChannel();
  await test('bounded retries reach DLQ and corrected handler can replay', async () => {
    const e = event();
    await request('order', '/_platform/probe', {
      runId: e.demo.runId,
      kind: 'fault',
      eventName: e.eventName,
      remaining: 4,
    });
    await request('auction', '/_platform/events', e);
    const held = [];
    let match;
    try {
      await until(
        async () => {
          let msg;
          while (
            (msg = await ch.get('queue.order.events.dlq', { noAck: false }))
          ) {
            let data;
            try {
              data = JSON.parse(msg.content);
            } catch {}
            if (data?.eventId === e.eventId) {
              match = msg;
              return true;
            }
            held.push(msg);
          }
          return false;
        },
        'bounded retry DLQ',
        30000,
      );
      ch.sendToQueue('queue.order.events', match.content, {
        persistent: true,
        contentType: 'application/json',
        headers: { 'x-retry-count': 0 },
      });
      await ch.waitForConfirms();
      ch.ack(match);
      await until(() => observed('order', e), 'DLQ replay');
    } finally {
      for (const msg of held) ch.nack(msg, false, true);
    }
  });
  await ch.close();
  await test('Redis adapter broadcasts across two Auction instances', async () => {
    docker([
      ...compose,
      'run',
      '-d',
      '--no-deps',
      '--name',
      replica,
      '-p',
      `127.0.0.1:${replicaPort}:3003`,
      'auction-service',
    ]);
    replicaCreated = true;
    await until(async () => {
      const r = await fetch(`http://127.0.0.1:${replicaPort}/health/ready`);
      return r.ok;
    }, 'second Auction instance');
    const login = await request('auth', '/login', {
      email: 'bidder@auction.test',
      password: process.env.SEED_PASSWORD,
    });
    const e = event();
    const received = [false, false];
    for (const [i, url] of [
      base('auction'),
      `http://127.0.0.1:${replicaPort}`,
    ].entries()) {
      const socket = io(url + '/auctions', {
        transports: ['websocket'],
        auth: { token: login.accessToken },
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      });
      const ack = await socket
        .timeout(3000)
        .emitWithAck('auction:subscribe', { auctionId: e.payload.auctionId });
      assert(ack.ok);
      socket.on('auction:status_changed', (p) => {
        if (p.auctionId === e.payload.auctionId) received[i] = true;
      });
    }
    await request('auction', '/_platform/events', e);
    await until(() => received.every(Boolean), 'cross-instance broadcast');
  });
} finally {
  for (const s of sockets) s.close();
  await connection?.close();
  if (replicaCreated) docker(['rm', '-f', replica]);
  // Restore only the isolated verification services if a test failed mid-operation.
  docker([...compose, 'start', 'rabbitmq', 'order-service']);
  writeFileSync(
    '.local/resilience-report.json',
    JSON.stringify({ at: new Date().toISOString(), project, checks }, null, 2) +
      '\n',
  );
}
