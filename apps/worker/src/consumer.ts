import { Worker, type Job } from 'bullmq';
import {
  QueueJobSchema,
  AccountSessionProfileSchema,
  AccountStatus,
  MessageStatus,
  type QueueJob,
} from '@claude-queue/shared-types';
import { config } from './config.js';
import { getJobById, updateJobStatus, updateAccountStatus } from './db/prisma-client.js';
import { downloadAttachment } from './storage/s3-client.js';
import { createBrowserContext, closeBrowser } from './browser/context-factory.js';
import { executeClaudePrompt, type AutomationPayload } from './browser/claude-automator.js';

const QUEUE_NAME = 'claude-queue';

/**
 * Parse the Redis URL into BullMQ connection options.
 */
function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    password: parsed.password || undefined,
  };
}

/**
 * Process a single queue job.
 */
async function processJob(job: Job): Promise<void> {
  const startTime = Date.now();
  console.log(`\n🔄 Processing job ${job.id} (attempt ${job.attemptsMade + 1})`);

  // 1. Parse and validate the job payload
  const parseResult = QueueJobSchema.safeParse(job.data);
  if (!parseResult.success) {
    console.error('  ❌ Invalid job payload:', parseResult.error.format());
    throw new Error(`Invalid job payload: ${parseResult.error.message}`);
  }

  const payload: QueueJob = parseResult.data;
  console.log(`  📋 Job ID: ${payload.jobId}`);
  console.log(`  👤 Account ID: ${payload.accountId}`);
  console.log(`  🎯 Model: ${payload.modelTarget}`);
  console.log(`  💬 Conversation: ${payload.conversationId ?? 'new'}`);
  console.log(`  🧠 Thinking: ${payload.thinkingMode}`);
  console.log(`  📎 Attachments: ${payload.attachments.length}`);

  // 2. Update DB status to PROCESSING
  await updateJobStatus(payload.jobId, MessageStatus.PROCESSING);

  // 3. Fetch the full job record from DB (includes Account with session_profile)
  const dbRecord = await getJobById(payload.jobId);
  if (!dbRecord) {
    throw new Error(`Job ${payload.jobId} not found in database`);
  }

  // 4. Validate the session profile
  const sessionParseResult = AccountSessionProfileSchema.safeParse(
    dbRecord.account.session_profile,
  );
  if (!sessionParseResult.success) {
    console.error(
      '  ❌ Invalid session profile:',
      sessionParseResult.error.format(),
    );
    await updateJobStatus(payload.jobId, MessageStatus.FAILED);
    throw new Error(
      `Invalid session profile for account ${payload.accountId}: ${sessionParseResult.error.message}`,
    );
  }

  const sessionProfile = sessionParseResult.data;

  // 5. Download attachment buffers from S3
  const attachmentBuffers: AutomationPayload['attachmentBuffers'] = [];
  for (const attachment of payload.attachments) {
    console.log(`  📥 Downloading attachment: ${attachment.fileName}`);
    try {
      const buffer = await downloadAttachment(attachment.storageKey);
      attachmentBuffers.push({
        buffer,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ Failed to download attachment ${attachment.fileName}: ${msg}`);
      await updateJobStatus(payload.jobId, MessageStatus.FAILED);
      throw new Error(`Failed to download attachment: ${msg}`);
    }
  }

  // 6. Create browser context
  let context;
  try {
    context = await createBrowserContext(sessionProfile, config.browserHeadless);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ Failed to create browser context: ${msg}`);
    await updateJobStatus(payload.jobId, MessageStatus.FAILED);
    throw new Error(`Browser context creation failed: ${msg}`);
  }

  try {
    // 7. Execute the automation
    const automationPayload: AutomationPayload = {
      conversationId: payload.conversationId,
      modelTarget: payload.modelTarget,
      promptText: payload.promptText,
      thinkingMode: payload.thinkingMode,
      attachmentBuffers,
    };

    const result = await executeClaudePrompt(context, automationPayload);

    // 8. Handle the result
    if (result.success) {
      await updateJobStatus(payload.jobId, MessageStatus.COMPLETED);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ✅ Job ${payload.jobId} completed in ${elapsed}s`);
      console.log(
        `  📝 Response preview: ${(result.responseText ?? '').substring(0, 100)}...`,
      );
    } else {
      // Handle specific error types
      if (result.error === 'CHALLENGE_RAISED') {
        console.log(
          `  🚫 Challenge raised — marking account ${payload.accountId} as CHALLENGE_RAISED`,
        );
        await updateAccountStatus(payload.accountId, AccountStatus.CHALLENGE_RAISED);
      } else if (result.error === 'SESSION_EXPIRED') {
        console.log(
          `  🔑 Session expired — marking account ${payload.accountId} as EXPIRED`,
        );
        await updateAccountStatus(payload.accountId, AccountStatus.EXPIRED);
      }

      await updateJobStatus(payload.jobId, MessageStatus.FAILED);
      throw new Error(`Automation failed: ${result.error}`);
    }
  } finally {
    // 9. Always close the browser context to prevent memory leaks
    console.log('  🧹 Closing browser context...');
    await context.close().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ⚠️  Error closing browser context: ${msg}`);
    });
  }
}

/**
 * Start the BullMQ consumer worker.
 */
export async function startConsumer(): Promise<Worker> {
  const connection = parseRedisUrl(config.redisUrl);

  console.log(`📡 Connecting to Redis at ${config.redisUrl}`);
  console.log(`🔧 Concurrency: ${config.concurrency}`);
  console.log(`🌐 Headless: ${config.browserHeadless}`);

  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      await processJob(job);
    },
    {
      connection,
      concurrency: config.concurrency,
      // Remove completed jobs after 1 hour, keep failed jobs for 24 hours
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400, count: 5000 },
    },
  );

  worker.on('completed', (job: Job) => {
    console.log(`✅ Job ${job.id} completed successfully`);
  });

  worker.on('failed', async (job: Job | undefined, err: Error) => {
    console.error(`❌ Job ${job?.id ?? 'unknown'} failed: ${err.message}`);
    // Ensure the DB reflects FAILED even after all retries are exhausted.
    // processJob may have left the status as PROCESSING on the final attempt.
    if (job) {
      try {
        const payload = QueueJobSchema.safeParse(job.data);
        if (payload.success) {
          await updateJobStatus(payload.data.jobId, MessageStatus.FAILED);
        }
      } catch (dbErr) {
        console.error(`  ⚠️  Failed to update DB status for failed job: ${(dbErr as Error).message}`);
      }
    }
  });

  worker.on('error', (err: Error) => {
    console.error('🚨 Worker error:', err.message);
  });

  worker.on('stalled', (jobId: string) => {
    console.warn(`⚠️  Job ${jobId} stalled`);
  });

  // Wait for the worker to be ready
  await worker.waitUntilReady();

  return worker;
}

/**
 * Gracefully shut down the consumer and browser.
 */
export async function shutdownConsumer(worker: Worker): Promise<void> {
  console.log('🛑 Closing worker...');
  await worker.close();
  console.log('🌐 Closing browser...');
  await closeBrowser();
  console.log('👋 Shutdown complete');
}
