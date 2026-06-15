import { z } from 'zod';

// Max 10MB per attachment (base64 ~13.3MB encoded), max 5 attachments
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const AttachmentInputSchema = z.object({
  /** Base64-encoded file content */
  fileBase64: z
    .string()
    .min(1, 'fileBase64 is required')
    .max(MAX_ATTACHMENT_BYTES * 1.4, 'fileBase64 exceeds maximum size'),
  fileName: z
    .string()
    .min(1, 'fileName is required')
    .max(255)
    .transform((name) => name.replace(/[/\\]|^\.+|\.\./g, '_')),
  mimeType: z
    .string()
    .min(1, 'mimeType is required')
    .max(255),
});

export const CreateJobSchema = z.object({
  accountId: z.string().uuid('accountId must be a valid UUID'),
  conversationId: z.string().optional(),
  modelTarget: z.string().min(1).max(100, 'modelTarget is required'),
  promptText: z.string().min(1, 'promptText is required').max(100_000),
  thinkingMode: z.boolean().optional().default(false),
  scheduledFor: z.string().datetime({ message: 'scheduledFor must be a valid ISO 8601 datetime' }).optional(),
  delaySeconds: z.number().int().min(0).max(365 * 24 * 3600).optional(),
  attachments: z.array(AttachmentInputSchema).max(5).optional().default([]),
}).refine(
  (data) => data.scheduledFor != null || data.delaySeconds != null,
  { message: 'Either scheduledFor (ISO datetime) or delaySeconds (seconds from now) is required' },
);

export type CreateJobDto = z.infer<typeof CreateJobSchema>;
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;
