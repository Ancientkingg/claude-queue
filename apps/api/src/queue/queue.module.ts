import { Module } from '@nestjs/common';
import { QueueController } from './queue.controller.js';
import { QueueService } from './queue.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { BullModule } from '../bull/bull.module.js';

@Module({
  imports: [StorageModule, BullModule],
  controllers: [QueueController],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
