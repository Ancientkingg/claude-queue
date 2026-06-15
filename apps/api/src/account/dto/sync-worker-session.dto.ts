import { z } from 'zod';
import { AccountSessionProfileSchema } from '@claude-queue/shared-types';

export const SyncWorkerSessionSchema = z.object({
  accountId: z.string().uuid('accountId must be a valid UUID'),
  workerSessionProfile: AccountSessionProfileSchema,
});

export type SyncWorkerSessionDto = z.infer<typeof SyncWorkerSessionSchema>;
