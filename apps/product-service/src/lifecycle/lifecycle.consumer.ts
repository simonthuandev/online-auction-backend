import { Injectable, Logger } from '@nestjs/common';
import {
  PermanentMessageError,
  type Transaction,
  type IntegrationEvent,
} from '@app/common';
import { LifecycleRepository } from './lifecycle.repository.js';
import { decideLifecycleTransition } from './lifecycle.decision.js';
import type {
  AuctionStartedEvent,
  AuctionEndedEvent,
} from './lifecycle.types.js';

@Injectable()
export class LifecycleConsumer {
  private readonly logger = new Logger(LifecycleConsumer.name);

  constructor(private readonly repository: LifecycleRepository) {}

  async handleAuctionStarted(
    tx: Transaction,
    event: IntegrationEvent,
  ): Promise<void> {
    if (event.eventName !== 'auction.started') {
      throw new PermanentMessageError(
        `INVALID_EVENT_NAME: Expected auction.started, got ${event.eventName}`,
      );
    }

    this.validateStartedEvent(event);

    const product = await this.repository.lockAndFindProductByAuctionId(
      tx,
      event.payload.auctionId,
    );

    const decision = decideLifecycleTransition(product, event);

    if (decision.action === 'IGNORE') {
      this.logger.debug(
        `Ignored auction.started event ${event.eventId} for auction ${event.payload.auctionId}: ${decision.reason}`,
      );
      return;
    }

    await this.repository.updateProductLifecycle(tx, decision);
  }

  async handleAuctionEnded(
    tx: Transaction,
    event: IntegrationEvent,
  ): Promise<void> {
    if (event.eventName !== 'auction.ended') {
      throw new PermanentMessageError(
        `INVALID_EVENT_NAME: Expected auction.ended, got ${event.eventName}`,
      );
    }

    this.validateEndedEvent(event);

    const product = await this.repository.lockAndFindProductByAuctionId(
      tx,
      event.payload.auctionId,
    );

    const decision = decideLifecycleTransition(product, event);

    if (decision.action === 'IGNORE') {
      this.logger.debug(
        `Ignored auction.ended event ${event.eventId} for auction ${event.payload.auctionId}: ${decision.reason}`,
      );
      return;
    }

    await this.repository.updateProductLifecycle(tx, decision);
  }

  private validateStartedEvent(
    event: unknown,
  ): asserts event is AuctionStartedEvent {
    if (!event || typeof event !== 'object') {
      throw new PermanentMessageError('INVALID_EVENT: Event must be an object');
    }
    const e = event as Record<string, any>;
    if (
      typeof e.aggregateVersion !== 'number' ||
      e.aggregateVersion < 1 ||
      !Number.isInteger(e.aggregateVersion)
    ) {
      throw new PermanentMessageError(
        'INVALID_EVENT: aggregateVersion must be an integer >= 1',
      );
    }
    const payload = e.payload;
    if (!payload || typeof payload !== 'object') {
      throw new PermanentMessageError('INVALID_EVENT: payload must be an object');
    }
    if (!payload.auctionId || typeof payload.auctionId !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.auctionId is required',
      );
    }
    if (!payload.productId || typeof payload.productId !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.productId is required',
      );
    }
    if (!payload.sellerId || typeof payload.sellerId !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.sellerId is required',
      );
    }
    if (!payload.startTime || typeof payload.startTime !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.startTime is required',
      );
    }
    if (!payload.endTime || typeof payload.endTime !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.endTime is required',
      );
    }
  }

  private validateEndedEvent(
    event: unknown,
  ): asserts event is AuctionEndedEvent {
    if (!event || typeof event !== 'object') {
      throw new PermanentMessageError('INVALID_EVENT: Event must be an object');
    }
    const e = event as Record<string, any>;
    if (
      typeof e.aggregateVersion !== 'number' ||
      e.aggregateVersion < 1 ||
      !Number.isInteger(e.aggregateVersion)
    ) {
      throw new PermanentMessageError(
        'INVALID_EVENT: aggregateVersion must be an integer >= 1',
      );
    }
    const payload = e.payload;
    if (!payload || typeof payload !== 'object') {
      throw new PermanentMessageError('INVALID_EVENT: payload must be an object');
    }
    if (!payload.auctionId || typeof payload.auctionId !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.auctionId is required',
      );
    }
    if (!payload.productId || typeof payload.productId !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.productId is required',
      );
    }
    if (typeof payload.productTitle !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.productTitle is required',
      );
    }
    if (
      payload.productThumbnail !== null &&
      typeof payload.productThumbnail !== 'string'
    ) {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.productThumbnail must be string or null',
      );
    }
    if (!payload.sellerId || typeof payload.sellerId !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.sellerId is required',
      );
    }
    if (payload.winnerId !== null && typeof payload.winnerId !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.winnerId must be string or null',
      );
    }
    if (payload.finalPrice !== null && typeof payload.finalPrice !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.finalPrice must be string or null',
      );
    }
    if (payload.currency !== 'VND') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.currency must be VND',
      );
    }
    if (!payload.endedAt || typeof payload.endedAt !== 'string') {
      throw new PermanentMessageError(
        'INVALID_EVENT: payload.endedAt is required',
      );
    }
  }
}
