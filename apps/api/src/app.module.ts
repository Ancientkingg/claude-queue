import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AccountModule } from './account/account.module.js';
import { QueueModule } from './queue/queue.module.js';
import { StorageModule } from './storage/storage.module.js';
import { BullModule } from './bull/bull.module.js';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    AccountModule,
    QueueModule,
    StorageModule,
    BullModule,
  ],
})
export class AppModule {}
