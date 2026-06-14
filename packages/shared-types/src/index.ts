import { z } from 'zod';

// === Session Profile (for Cloudflare bypass) ===
export const CookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
});
export type Cookie = z.infer<typeof CookieSchema>;

export const AccountSessionProfileSchema = z.object({
  cookies: z.array(CookieSchema),
  userAgent: z.string(),
  localStorageSnapshot: z.record(z.string(), z.string()),
  timezoneId: z.string(),
});
export type AccountSessionProfile = z.infer<typeof AccountSessionProfileSchema>;

// === Queue Job Payload ===
export const AttachmentPayloadSchema = z.object({
  storageKey: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
});
export type AttachmentPayload = z.infer<typeof AttachmentPayloadSchema>;

export const QueueJobSchema = z.object({
  jobId: z.string().uuid(),
  accountId: z.string().uuid(),
  conversationId: z.string().nullable(),
  modelTarget: z.string(),
  promptText: z.string(),
  thinkingMode: z.boolean().default(false),
  attachments: z.array(AttachmentPayloadSchema),
});
export type QueueJob = z.infer<typeof QueueJobSchema>;

// === Account Status Enum ===
export const AccountStatus = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  CHALLENGE_RAISED: 'CHALLENGE_RAISED',
} as const;
export type AccountStatus = (typeof AccountStatus)[keyof typeof AccountStatus];

// === Message Status Enum ===
export const MessageStatus = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];
