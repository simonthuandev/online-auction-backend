import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import amqp, {
  type AmqpConnectionManager,
  type ChannelWrapper,
} from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { RMQ_BINDINGS, RMQ_EXCHANGES } from '../constants/rmq.constant.js';
import {
  validateEvent,
  PermanentMessageError,
  type IntegrationEvent,
} from '../platform/contracts.js';
@Injectable()
export class RmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RmqService.name);
  private connection!: AmqpConnectionManager;
  private publisher!: ChannelWrapper;
  private channels: ChannelWrapper[] = [];
  private returned = new Set<string>();
  private stopping = false;
  private active = new Set<Promise<void>>();
  private consumers = new Map<ConfirmChannel, string>();
  get connected() {
    return this.connection?.isConnected() || false;
  }
  onModuleInit() {
    this.connection = amqp.connect([process.env.RABBITMQ_URL!], {
      heartbeatIntervalInSeconds: 5,
      reconnectTimeInSeconds: 2,
    });
    this.connection.on('disconnect', () =>
      this.logger.warn('RabbitMQ disconnected; outbox retained'),
    );
    this.publisher = this.connection.createChannel({
      json: true,
      confirm: true,
      setup: async (channel: ConfirmChannel) => {
        for (const exchange of Object.values(RMQ_EXCHANGES))
          await channel.assertExchange(exchange, 'topic', { durable: true });
        for (const entry of RMQ_BINDINGS) {
          await channel.assertQueue(entry.queue, { durable: true });
          await channel.assertQueue(entry.queue + '.dlq', { durable: true });
          await channel.assertQueue(entry.queue + '.retry', {
            durable: true,
            arguments: {
              'x-message-ttl': 5000,
              'x-dead-letter-exchange': '',
              'x-dead-letter-routing-key': entry.queue,
            },
          });
          for (const [exchange, key] of entry.bindings)
            await channel.bindQueue(entry.queue, exchange, key);
        }
        channel.on('return', (msg) =>
          this.returned.add(msg.properties.messageId),
        );
      },
    });
  }
  async publish(
    exchange: string,
    routingKey: string,
    event: IntegrationEvent,
  ): Promise<void> {
    validateEvent(event);
    await this.publishRaw(exchange, routingKey, event);
  }
  private async publishRaw(
    exchange: string,
    key: string,
    payload: unknown,
    headers: Record<string, unknown> = {},
  ) {
    if (this.stopping || !this.connected) throw Error('BROKER_UNAVAILABLE');
    const messageId = randomUUID();
    try {
      await this.publisher.publish(exchange, key, payload, {
        persistent: true,
        mandatory: true,
        contentType: 'application/json',
        messageId,
        headers,
        timeout: 5000,
      });
      if (this.returned.has(messageId))
        throw new PermanentMessageError('UNROUTABLE_MESSAGE');
    } finally {
      this.returned.delete(messageId);
    }
  }
  async consume(
    queue: string,
    onMessage: (event: IntegrationEvent) => Promise<void>,
  ) {
    const wrapper = this.connection.createChannel({
      setup: async (channel: ConfirmChannel) => {
        await channel.assertQueue(queue, { durable: true });
        await channel.prefetch(10);
        const consumer = await channel.consume(
          queue,
          (msg: ConsumeMessage | null) => {
            if (!msg) return;
            if (this.stopping) {
              channel.nack(msg, false, true);
              return;
            }
            const work = this.process(channel, queue, msg, onMessage);
            this.active.add(work);
            void work
              .catch(() =>
                this.logger.warn('Consumer channel closed during shutdown'),
              )
              .finally(() => this.active.delete(work));
          },
          { noAck: false },
        );
        this.consumers.set(channel, consumer.consumerTag);
        channel.on('close', () => this.consumers.delete(channel));
      },
    });
    this.channels.push(wrapper);
  }
  private async process(
    channel: ConfirmChannel,
    queue: string,
    msg: ConsumeMessage,
    fn: (event: IntegrationEvent) => Promise<void>,
  ) {
    try {
      const event: unknown = JSON.parse(msg.content.toString());
      validateEvent(event);
      await fn(event);
      channel.ack(msg);
    } catch (error) {
      const retry = Number(msg.properties.headers?.['x-retry-count'] || 0);
      const permanent =
        error instanceof PermanentMessageError || error instanceof SyntaxError;
      const target =
        permanent || retry >= 3 ? queue + '.dlq' : queue + '.retry';
      this.logger.warn(
        JSON.stringify({
          queue,
          target,
          retry,
          messageId: msg.properties.messageId,
          error: error instanceof Error ? error.message : 'consumer failed',
        }),
      );
      try {
        const raw = JSON.parse(msg.content.toString());
        await this.publishRaw('', target, raw, {
          'x-retry-count': retry + 1,
          'x-original-queue': queue,
        });
        channel.ack(msg);
      } catch {
        try {
          // Preserve malformed JSON bytes in DLQ; JSON wrapping is intentionally explicit.
          if (permanent && error instanceof SyntaxError) {
            await this.publishRaw(
              '',
              queue + '.dlq',
              { malformed: msg.content.toString() },
              { 'x-original-queue': queue },
            );
            channel.ack(msg);
          } else channel.nack(msg, false, true);
        } catch {
          channel.nack(msg, false, true);
        }
      }
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled(
      [...this.consumers].map(([channel, tag]) => channel.cancel(tag)),
    );
    await Promise.race([
      Promise.allSettled(this.active),
      new Promise((r) => setTimeout(r, 5000).unref()),
    ]);
    await Promise.allSettled(this.channels.map((c) => c.close()));
    await this.publisher?.close();
    await this.connection?.close();
  }
}
