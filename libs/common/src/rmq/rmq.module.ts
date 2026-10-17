import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RmqService } from './rmq.service.js';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RmqService],
  exports: [RmqService],
})
export class RmqModule {}
