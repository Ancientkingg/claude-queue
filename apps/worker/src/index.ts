import { config } from './config.js';
import { startConsumer, shutdownConsumer } from './consumer.js';
import { closeBrowser } from './browser/context-factory.js';
import { prisma } from './db/prisma-client.js';

async function main(): Promise<void> {
  console.log('🔧 Claude Queue Worker starting...');
  console.log(`📡 Redis: ${config.redisUrl}`);
  console.log(`🗄️  Database: ${config.databaseUrl.replace(/\/\/.*@/, '//<redacted>@')}`);
  console.log(`📦 S3 Endpoint: ${config.s3Endpoint}`);
  console.log(`🌐 Headless: ${config.browserHeadless}`);
  console.log(`⚙️  Concurrency: ${config.concurrency}`);

  const worker = await startConsumer();

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`);

    try {
      await shutdownConsumer(worker);
      // closeBrowser() already called in shutdownConsumer
      await prisma.$disconnect();
      console.log('👋 Worker shut down cleanly');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`❌ Error during shutdown: ${msg}`);
    }

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log('✅ Worker is ready and listening for jobs on queue "claude-queue"');
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('❌ Worker failed to start:', msg);
  process.exit(1);
});
