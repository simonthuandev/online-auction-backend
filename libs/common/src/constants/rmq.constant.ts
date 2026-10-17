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

export const RMQ_QUEUES = {
  PRODUCT_AUCTION_STARTED: 'queue.product.auction-started',
  PRODUCT_AUCTION_ENDED: 'queue.product.auction-ended',
  ORDER_AUCTION_ENDED: 'queue.order.auction-ended',
  ORDER_PAYMENT_SUCCEEDED: 'queue.order.payment-succeeded',
  NOTIFICATION_BID_PLACED: 'queue.notification.bid-placed',
  NOTIFICATION_AUCTION_ENDED: 'queue.notification.auction-ended',
  NOTIFICATION_PAYMENT_SUCCEEDED: 'queue.notification.payment-succeeded',
} as const;
