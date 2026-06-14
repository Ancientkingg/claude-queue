import { z } from 'zod';
import { AccountSessionProfileSchema } from '@claude-queue/shared-types';

export const SyncAccountSchema = z.object({
  accountName: z.string().min(1, 'accountName is required'),
  sessionProfile: AccountSessionProfileSchema,
});

export type SyncAccountDto = z.infer<typeof SyncAccountSchema>;
