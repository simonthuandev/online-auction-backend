import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AuthServiceModule } from './auth-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AuthServiceModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT') || 3001;

  await app.listen(port , '0.0.0.0'); // binding o tang 7
}
await bootstrap();
