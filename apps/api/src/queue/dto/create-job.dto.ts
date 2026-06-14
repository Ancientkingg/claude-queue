import { z } from 'zod';

export const AttachmentInputSchema = z.object({
  /** Base64-encoded file content */
  fileBase64: z.string().min(1, 'fileBase64 is required'),
  fileName: z.string().min(1, 'fileName is required'),
  mimeType: z.string().min(1, 'mimeType is required'),
});

export const CreateJobSchema = z.object({
  accountId: z.string().uuid('accountId must be a valid UUID'),
  conversationId: z.string().optional(),
  modelTarget: z.string().min(1, 'modelTarget is required'),
  promptText: z.string().min(1, 'promptText is required'),
  thinkingMode: z.boolean().optional().default(false),
  scheduledFor: z.string().datetime({ message: 'scheduledFor must be a valid ISO 8601 datetime' }),
  attachments: z.array(AttachmentInputSchema).optional().default([]),
});

export type CreateJobDto = z.infer<typeof CreateJobSchema>;
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>;
