import { Module, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { QUEUE_NAME, getRedisConnection } from './bull.config.js';

export const BULL_QUEUE = 'BULL_QUEUE';

@Module({
  providers: [
    {
      provide: BULL_QUEUE,
      useFactory: () => {
        const logger = new Logger('BullModule');
        const connection = getRedisConnection();
        const queue = new Queue(QUEUE_NAME, { connection });
        logger.log(`BullMQ queue "${QUEUE_NAME}" initialized`);
        return queue;
      },
    },
  ],
  exports: [BULL_QUEUE],
})
export class BullModule {}
