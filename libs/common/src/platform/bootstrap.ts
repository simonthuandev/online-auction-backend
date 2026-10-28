import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, type Type } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { json } from 'express';
import { registerPlatformHttp, PlatformExceptionFilter } from './http.js';
import { Realtime } from './realtime.js';
export function loadPlatformEnvironment(service: string) {
  const file = process.env.PLATFORM_ENV_FILE || '.env';
  if (existsSync(file)) process.loadEnvFile(file);
  process.env.SERVICE_NAME = service;
  const key = service.toUpperCase();
  if (process.env[key + '_DB_USER'])
    process.env[key + '_DATABASE_URL'] =
      `postgresql://${process.env[key + '_DB_USER']}:${encodeURIComponent(process.env[key + '_DB_PASSWORD']!)}@localhost:${process.env.POSTGRES_PORT || 5432}/${service}_db`;
  if (process.env.REDIS_PASSWORD)
    process.env.REDIS_URL = `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@localhost:${process.env.REDIS_PORT || 6379}`;
  for (const name of [
    `${service.toUpperCase()}_DATABASE_URL`,
    'JWT_PUBLIC_KEY_PATH',
    'JWT_ISSUER',
    'JWT_AUDIENCE',
    'RABBITMQ_URL',
    'REDIS_URL',
    'PLATFORM_ADMIN_KEY',
  ])
    if (!process.env[name])
      throw Error(`Missing required configuration: ${name}`);
  for (const key of [
    'RABBITMQ_URL',
    'REDIS_URL',
    `${service.toUpperCase()}_DATABASE_URL`,
  ])
    new URL(process.env[key]!);
  if (
    !['development', 'test'].includes(process.env.NODE_ENV || 'production') &&
    process.env.PLATFORM_DEMO_ENABLED === 'true'
  )
    throw Error('Demo cannot be enabled in production');
}
export async function bootstrap(service: string, module: Type<unknown>) {
  const app = await NestFactory.create(module, { bodyParser: false });
  app.enableCors({
    origin: (process.env.CORS_ORIGINS || '').split(','),
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Request-Id',
      'X-Correlation-Id',
    ],
    exposedHeaders: ['X-Request-Id'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new PlatformExceptionFilter());
  app.enableShutdownHooks();
  app.use(json({ limit: '64kb' }));
  registerPlatformHttp(app, service);
  await app.init();
  app.get(Realtime).attach(app, service);
  const port = Number(
    process.env[service.toUpperCase() + '_PORT'] ||
      (
        {
          auth: 3001,
          product: 3002,
          auction: 3003,
          order: 3004,
          payment: 3005,
          notification: 3006,
        } as Record<string, number>
      )[service],
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error('Invalid service port');
  await app.listen(port, '0.0.0.0');
  return app;
}
