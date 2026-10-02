import { NestFactory } from '@nestjs/core';
import { AuthServiceModule } from './auth-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AuthServiceModule);
  await app.listen(process.env.port ?? 3001, '0.0.0.0'); // binding o tang 7
}
await bootstrap();
