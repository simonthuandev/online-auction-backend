export const RMQ_EXCHANGES = {
  AUCTION: 'auction_exchange',
  PAYMENT: 'payment_exchange',
} as const;
export const RMQ_ROUTING_KEYS = {
  AUCTION_STARTED: 'auction.started',
  BID_PLACED: 'bid.placed',
  AUCTION_ENDED: 'auction.ended',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
} as const;
export const RMQ_BINDINGS = [
  {
    service: 'product',
    queue: 'queue.product.auction-events',
    bindings: [
      ['auction_exchange', 'auction.started'],
      ['auction_exchange', 'auction.ended'],
    ],
  },
  {
    service: 'order',
    queue: 'queue.order.events',
    bindings: [
      ['auction_exchange', 'auction.ended'],
      ['payment_exchange', 'payment.succeeded'],
    ],
  },
  {
    service: 'notification',
    queue: 'queue.notification.events',
    bindings: [
      ['auction_exchange', 'bid.placed'],
      ['auction_exchange', 'auction.ended'],
      ['payment_exchange', 'payment.succeeded'],
    ],
  },
] as const;
export const RMQ_QUEUES = {
  PRODUCT: 'queue.product.auction-events',
  ORDER: 'queue.order.events',
  NOTIFICATION: 'queue.notification.events',
} as const;
