import { NestFactory } from '@nestjs/core';
import { AuctionServiceModule } from './auction-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AuctionServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
