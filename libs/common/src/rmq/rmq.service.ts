import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, { type ChannelWrapper, type AmqpConnectionManager } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { randomUUID } from 'crypto';
import type { BaseEvent } from '../contracts/base-event.interface.js';

@Injectable()
export class RmqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RmqService.name);
  private connection: AmqpConnectionManager | null = null;
  private channelWrapper: ChannelWrapper | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    const urls = [this.configService.get<string>('RABBITMQ_URL', 'amqp://localhost:5672')];
    this.connection = amqp.connect(urls);

    this.connection.on('connect', () => {
      this.logger.log('Connected to RabbitMQ server successfully');
    });

    this.connection.on('disconnect', (err) => {
      this.logger.error('Disconnected from RabbitMQ server', err?.err);
    });

    this.channelWrapper = this.connection.createChannel({
      json: true,
      setup: async (channel: ConfirmChannel) => {
        // Topic Exchanges
        await channel.assertExchange('auction_exchange', 'topic', { durable: true });
        await channel.assertExchange('payment_exchange', 'topic', { durable: true });
      },
    });

    await this.channelWrapper.waitForConnect();
  }

  async onModuleDestroy() {
    try {
      await this.channelWrapper?.close();
      await this.connection?.close();
      this.logger.log('RabbitMQ connection closed cleanly');
    } catch (error) {
      this.logger.error('Error closing RabbitMQ connection', error);
    }
  }

  /**
   * Publish an event wrapped in BaseEvent<T> to a topic exchange
   */
  async publish<T>(
    exchange: string,
    routingKey: string,
    payload: T,
    eventName?: string,
  ): Promise<void> {
    if (!this.channelWrapper) {
      throw new Error('RabbitMQ channel is not initialized');
    }

    const event: BaseEvent<T> = {
      eventId: randomUUID(),
      eventName: eventName || routingKey,
      timestamp: new Date().toISOString(),
      payload,
    };

    const messageBuffer = Buffer.from(JSON.stringify(event));

    await this.channelWrapper.publish(exchange, routingKey, messageBuffer, {
      persistent: true,
      contentType: 'application/json',
    });

    this.logger.debug(`Published event [${event.eventName}] (${event.eventId}) to ${exchange} with key '${routingKey}'`);
  }

  /**
   * Setup a queue with bindings and start consuming messages with manual ack
   */
  async consume<T>(
    queue: string,
    exchange: string,
    routingKey: string,
    onMessage: (event: BaseEvent<T>, raw: ConsumeMessage) => Promise<void>,
  ): Promise<void> {
    if (!this.connection) {
      throw new Error('RabbitMQ connection is not initialized');
    }

    const consumerChannel = this.connection.createChannel({
      setup: async (channel: ConfirmChannel) => {
        await channel.assertExchange(exchange, 'topic', { durable: true });
        await channel.assertQueue(queue, { durable: true });
        await channel.bindQueue(queue, exchange, routingKey);
        await channel.prefetch(10);

        await channel.consume(
          queue,
          async (msg: ConsumeMessage | null) => {
            if (!msg) return;

            try {
              const event: BaseEvent<T> = JSON.parse(msg.content.toString());
              await onMessage(event, msg);
              channel.ack(msg);
            } catch (err) {
              this.logger.error(`Error processing message from queue ${queue}:`, err);
              // Nack without requeue if unprocessable, or could implement dead-letter queue
              channel.nack(msg, false, false);
            }
          },
          { noAck: false },
        );
      },
    });

    await consumerChannel.waitForConnect();
    this.logger.log(`Consumer started for queue [${queue}] bound to [${exchange}] with key [${routingKey}]`);
  }
}
