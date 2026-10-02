import { NestFactory } from '@nestjs/core';
import { PaymentServiceModule } from './payment-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(PaymentServiceModule);
  await app.listen(process.env.port ?? 3000);
}
await bootstrap();
