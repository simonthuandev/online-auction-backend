import amqp from 'amqplib';
import { loadEnv } from './env.mjs';
loadEnv();
const connection = await amqp.connect(process.env.RABBITMQ_URL);
const channel = await connection.createConfirmChannel();
const queues = [
  'queue.product.auction-events',
  'queue.order.events',
  'queue.notification.events',
];
try {
  if (process.argv[2] === 'inspect') {
    for (const q of queues)
      for (const suffix of ['', '.retry', '.dlq']) {
        const info = await channel.checkQueue(q + suffix);
        console.log(
          JSON.stringify({
            queue: q + suffix,
            messages: info.messageCount,
            consumers: info.consumerCount,
          }),
        );
      }
  } else if (process.argv[2] === 'replay') {
    const q = process.argv[3];
    const count = Number(process.argv[4] || 1);
    if (
      !queues.includes(q) ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100
    )
      throw Error('Usage: rmq:replay -- <main-queue> <count 1..100>');
    for (let i = 0; i < count; i++) {
      const msg = await channel.get(q + '.dlq', { noAck: false });
      if (!msg) break;
      channel.sendToQueue(q, msg.content, {
        persistent: true,
        contentType: 'application/json',
        headers: { 'x-retry-count': 0 },
      });
      await channel.waitForConfirms();
      channel.ack(msg);
      console.log('Replayed one message to ' + q);
    }
  } else throw Error('Expected inspect or replay');
} finally {
  await channel.close();
  await connection.close();
}
