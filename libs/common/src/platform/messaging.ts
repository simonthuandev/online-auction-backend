import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PLATFORM_DB, type Database, type Transaction } from './database.js';
import { RmqService } from '../rmq/rmq.service.js';
import { RMQ_BINDINGS } from '../constants/rmq.constant.js';
import {
  PermanentMessageError,
  validateEvent,
  type IntegrationEvent,
} from './contracts.js';
import { Realtime } from './realtime.js';
export type BusinessHandler = (
  tx: Transaction,
  event: IntegrationEvent,
) => Promise<void | (() => void | Promise<void>)>;
@Injectable()
export class EventHandlers {
  private handlers = new Map<string, BusinessHandler>();
  register(name: IntegrationEvent['eventName'], handler: BusinessHandler) {
    this.handlers.set(name, handler);
  }
  get(name: string) {
    return this.handlers.get(name);
  }
}
export async function enqueueEvent(tx: Transaction, event: IntegrationEvent) {
  validateEvent(event);
  await tx.execute(
    'INSERT INTO "OutboxEvent" (id,"aggregateId","aggregateVersion",exchange,"routingKey",envelope) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    event.eventId,
    event.aggregateId,
    event.aggregateVersion,
    event.producer === 'auction' ? 'auction_exchange' : 'payment_exchange',
    event.eventName,
    JSON.stringify(event),
  );
}
@Injectable()
export class Messaging implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private running?: Promise<void>;
  private readonly owner = randomUUID();
  constructor(
    @Inject(PLATFORM_DB) private readonly db: Database,
    private readonly rmq: RmqService,
    private readonly handlers: EventHandlers,
    private readonly realtime: Realtime,
  ) {}
  async onApplicationBootstrap() {
    const service = process.env.SERVICE_NAME!;
    const entry = RMQ_BINDINGS.find((b) => b.service === service);
    if (entry)
      await this.rmq.consume(entry.queue, (event) =>
        this.handle(entry.queue, event),
      );
    if (['auction', 'payment'].includes(service)) {
      this.timer = setInterval(() => {
        this.running = this.relay();
      }, 500);
      this.timer.unref();
    }
  }
  async handle(consumerName: string, event: IntegrationEvent) {
    if (event.demo && process.env.PLATFORM_DEMO_ENABLED !== 'true')
      throw new PermanentMessageError('DEMO_DISABLED');
    const handler = this.handlers.get(event.eventName);
    if (!event.demo && !handler)
      throw new PermanentMessageError('FEATURE_NOT_IMPLEMENTED');
    let applied = false;
    const committed: { effect?: () => void | Promise<void> } = {};
    await this.db.transaction(async (tx) => {
      const inserted = await tx.query(
        'INSERT INTO "ProcessedEvent" ("consumerName","eventId") VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING "eventId"',
        consumerName,
        event.eventId,
      );
      if (!inserted.length) return;
      if (event.demo) {
        // Controlled fault injection for bounded-retry integration tests; marker survives the rollback.
        const failures = await this.db.query<{ data: { remaining?: number } }>(
          'SELECT data FROM "PlatformProbe" WHERE "runId"=$1 AND kind=$2',
          event.demo.runId,
          'failure:' + event.eventName,
        );
        if (failures[0]?.data.remaining) {
          await this.db.execute(
            'UPDATE "PlatformProbe" SET data=jsonb_build_object(\'remaining\', $1::int) WHERE "runId"=$2 AND kind=$3',
            failures[0].data.remaining - 1,
            event.demo.runId,
            'failure:' + event.eventName,
          );
          throw Error('DEMO_TRANSIENT_FAILURE');
        }
        await tx.execute(
          'INSERT INTO "PlatformProbe" (id,"runId",kind,data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT ("runId",kind) DO NOTHING',
          randomUUID(),
          event.demo.runId,
          event.eventName,
          JSON.stringify(event),
        );
      } else committed.effect = (await handler!(tx, event)) || undefined;
      applied = true;
    });
    if (applied && committed.effect) {
      try {
        await committed.effect();
      } catch {
        console.warn(
          JSON.stringify({
            service: process.env.SERVICE_NAME,
            eventId: event.eventId,
            warning: 'After-commit notification failed; recover state via REST',
          }),
        );
      }
    }
    console.log(
      JSON.stringify({
        service: process.env.SERVICE_NAME,
        consumer: consumerName,
        eventId: event.eventId,
        eventName: event.eventName,
        aggregateId: event.aggregateId,
        correlationId: event.correlationId,
        applied,
      }),
    );
    if (applied && event.demo && process.env.SERVICE_NAME === 'notification') {
      const p = event.payload as unknown as Record<string, unknown>;
      const candidate =
        p.previousBidderId || p.winnerId || p.userId || p.sellerId;
      const userId = typeof candidate === 'string' ? candidate : '';
      if (userId)
        this.realtime.publishNotification(userId, {
          id: event.eventId,
          title: 'Platform connectivity demo',
          message: event.eventName,
          userId,
          isRead: false,
          type:
            event.eventName === 'bid.placed'
              ? 'OUTBID'
              : event.eventName === 'payment.succeeded'
                ? 'PAYMENT_SUCCESS'
                : p.winnerId
                  ? 'AUCTION_WON'
                  : 'AUCTION_ENDED',
          metadata: { demoRunId: event.demo.runId },
          createdAt: event.occurredAt,
        });
    }
  }
  async relay() {
    if (this.busy || !this.rmq.connected) return;
    this.busy = true;
    try {
      const rows = await this.db.transaction(async (tx) => {
        const pending = await tx.query<{
          id: string;
          exchange: string;
          routingKey: string;
          envelope: IntegrationEvent;
        }>(
          `SELECT o.* FROM "OutboxEvent" o WHERE o.status <> 'SENT' AND o."availableAt" <= now() AND (o."leaseUntil" IS NULL OR o."leaseUntil" < now()) AND NOT EXISTS (SELECT 1 FROM "OutboxEvent" older WHERE older."aggregateId"=o."aggregateId" AND older."aggregateVersion"<o."aggregateVersion" AND older.status<>'SENT') ORDER BY o."createdAt" LIMIT 10 FOR UPDATE SKIP LOCKED`,
        );
        for (const row of pending)
          await tx.execute(
            'UPDATE "OutboxEvent" SET "leaseOwner"=$1,"leaseUntil"=now()+interval \'15 seconds\' WHERE id=$2',
            this.owner,
            row.id,
          );
        return pending;
      });
      for (const row of rows) {
        try {
          await this.rmq.publish(row.exchange, row.routingKey, row.envelope);
          await this.db.execute(
            'UPDATE "OutboxEvent" SET status=\'SENT\',"sentAt"=now(),"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=$1 AND "leaseOwner"=$2',
            row.id,
            this.owner,
          );
          if (row.envelope.demo && process.env.SERVICE_NAME === 'auction') {
            const event = row.envelope;
            if (event.eventName === 'bid.placed')
              this.realtime.publishBidUpdate(event.payload.auctionId, {
                ...event.payload,
                version: event.aggregateVersion,
              });
            if (
              event.eventName === 'auction.started' ||
              event.eventName === 'auction.ended'
            )
              this.realtime.publishAuctionStatus(event.payload.auctionId, {
                ...event.payload,
                status:
                  event.eventName === 'auction.started' ? 'ACTIVE' : 'ENDED',
                version: event.aggregateVersion,
              });
          }
        } catch (error) {
          await this.db.execute(
            'UPDATE "OutboxEvent" SET attempts=attempts+1,"lastError"=$1,"availableAt"=now()+interval \'5 seconds\',"leaseUntil"=NULL,"leaseOwner"=NULL WHERE id=$2 AND "leaseOwner"=$3',
            error instanceof Error ? error.message : 'publish failed',
            row.id,
            this.owner,
          );
        }
      }
    } catch {
      /* Database outages are reported by readiness; the next tick retries. */
    } finally {
      this.busy = false;
    }
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
