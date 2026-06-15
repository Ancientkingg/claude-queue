import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { QueueModule } from './queue/queue.module.js';
import { AccountModule } from './account/account.module.js';
import { HealthModule } from './health/health.module.js';
import { StorageModule } from './storage/storage.module.js';

@Module({
  imports: [
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 30,
    }]),
    PrismaModule,
    AuthModule,
    QueueModule,
    AccountModule,
    HealthModule,
    StorageModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
