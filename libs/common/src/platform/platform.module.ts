import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { RmqService } from '../rmq/rmq.service.js';
import { AccessTokens } from './security.js';
import { PlatformRedis } from './redis.js';
import { InternalHttp } from './internal-http.js';
import { Realtime } from './realtime.js';
import { HttpHandlers } from './handlers.js';
import { Messaging, EventHandlers } from './messaging.js';
@Module({})
export class PlatformModule {
  static register(
    databaseModule: unknown,
    databaseProvider: Provider,
  ): DynamicModule {
    return {
      module: PlatformModule,
      global: true,
      imports: [databaseModule as never],
      providers: [
        databaseProvider,
        AccessTokens,
        PlatformRedis,
        InternalHttp,
        Realtime,
        RmqService,
        EventHandlers,
        HttpHandlers,
        Messaging,
      ],
      exports: [
        databaseProvider,
        AccessTokens,
        PlatformRedis,
        InternalHttp,
        Realtime,
        RmqService,
        EventHandlers,
        HttpHandlers,
      ],
    };
  }
}
