import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
@Injectable()
export class PlatformRedis implements OnModuleDestroy {
  readonly client: Redis;
  constructor() {
    this.client = new Redis(process.env.REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (n) => Math.min(n * 250, 5000),
    });
    this.client.on('error', () => {});
    void this.client.connect().catch(() => {});
  }
  key(name: string) {
    return `${process.env.SERVICE_NAME}:${name}`;
  }
  async probe(runId: string) {
    const key = this.key(`probe:${runId}`);
    await this.client.set(key, runId, 'EX', 30);
    const value = await this.client.get(key);
    return { value, ttl: await this.client.ttl(key) };
  }
  onModuleDestroy() {
    this.client.disconnect();
  }
}
