import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { INestApplication } from '@nestjs/common';
import type { Server, Namespace } from 'socket.io';
import { AccessTokens } from './security.js';
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@Injectable()
export class Realtime implements OnModuleDestroy {
  private io?: Server;
  private namespace?: Namespace;
  private pub?: Redis;
  private sub?: Redis;
  constructor(private readonly tokens: AccessTokens) {}
  attach(app: INestApplication, service: string) {
    if (!['auction', 'notification'].includes(service)) return;
    const io = new IoAdapter(app).createIOServer(0, {
      transports: ['websocket'],
      cors: { origin: (process.env.CORS_ORIGINS || '').split(',') },
    } as never) as Server;
    this.io = io;
    const opts = {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: (n: number) => Math.min(500 * n, 5000),
    };
    this.pub = new Redis(process.env.REDIS_URL!, opts);
    this.sub = this.pub.duplicate();
    this.pub.on('error', () => {});
    this.sub.on('error', () => {});
    io.adapter(createAdapter(this.pub, this.sub, { key: `${service}:socket` }));
    void this.pub.connect().catch(() => {});
    void this.sub.connect().catch(() => {});
    const ns = io.of(service === 'auction' ? '/auctions' : '/notifications');
    this.namespace = ns;
    ns.use((socket, next) => {
      try {
        socket.data.user = this.tokens.verify(socket.handshake.auth.token);
        next();
      } catch {
        next(new Error('UNAUTHORIZED'));
      }
    });
    ns.on('connection', (socket) => {
      const user = socket.data.user;
      const timer = setTimeout(
        () => socket.disconnect(true),
        Math.max(0, user.exp * 1000 - Date.now()),
      );
      timer.unref();
      socket.on('disconnect', () => clearTimeout(timer));
      if (service === 'notification') void socket.join(`user:${user.sub}`);
      else
        for (const action of ['subscribe', 'unsubscribe'])
          socket.on(
            `auction:${action}`,
            (input: { auctionId?: string }, ack?: (data: unknown) => void) => {
              const respond = typeof ack === 'function' ? ack : () => {};
              if (
                !input ||
                typeof input !== 'object' ||
                Object.keys(input).some((key) => key !== 'auctionId') ||
                typeof input.auctionId !== 'string' ||
                !uuid.test(input.auctionId)
              ) {
                respond({ ok: false, code: 'INVALID_AUCTION_ID' });
                return;
              }
              const task =
                action === 'subscribe'
                  ? socket.join(`auction:${input.auctionId}`)
                  : socket.leave(`auction:${input.auctionId}`);
              void Promise.resolve(task).then(() =>
                respond({ ok: true, auctionId: input.auctionId }),
              );
            },
          );
    });
  }
  publishBidUpdate(auctionId: string, payload: unknown) {
    this.namespace
      ?.to(`auction:${auctionId}`)
      .emit('auction:bid_updated', payload);
  }
  publishAuctionStatus(auctionId: string, payload: unknown) {
    this.namespace
      ?.to(`auction:${auctionId}`)
      .emit('auction:status_changed', payload);
  }
  publishNotification(userId: string, payload: unknown) {
    this.namespace?.to(`user:${userId}`).emit('notification:new', payload);
  }
  async onModuleDestroy() {
    if (this.io)
      await new Promise<void>((resolve) => this.io!.close(() => resolve()));
    this.pub?.disconnect();
    this.sub?.disconnect();
  }
}
