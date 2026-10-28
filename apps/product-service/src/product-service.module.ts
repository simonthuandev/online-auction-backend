import { Module } from '@nestjs/common';
import { ServiceHandlers } from './service-handlers.js';
import { PlatformModule, PLATFORM_DB, type Transaction } from '@app/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { PrismaService } from './prisma/prisma.service.js';
@Module({
  providers: [ServiceHandlers],
  imports: [
    PlatformModule.register(PrismaModule, {
      provide: PLATFORM_DB,
      inject: [PrismaService],
      useFactory: (db: PrismaService) => ({
        query: <T>(sql: string, ...values: unknown[]) =>
          db.$queryRawUnsafe<T[]>(sql, ...values),
        execute: (sql: string, ...values: unknown[]) =>
          db.$executeRawUnsafe(sql, ...values),
        transaction: <T>(fn: (tx: Transaction) => Promise<T>) =>
          db.$transaction((tx) =>
            fn({
              query: <R>(sql: string, ...values: unknown[]) =>
                tx.$queryRawUnsafe<R[]>(sql, ...values),
              execute: (sql: string, ...values: unknown[]) =>
                tx.$executeRawUnsafe(sql, ...values),
            }),
          ),
      }),
    }),
  ],
})
export class ProductServiceModule {}
