// Worker configuration loaded from environment variables

export interface WorkerConfig {
  redisUrl: string;
  databaseUrl: string;
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  browserHeadless: boolean;
  concurrency: number;
}

function requireEnv(name: string, fallback?: string): string {
  const value = (process.env[name] ?? fallback)?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config: WorkerConfig = {
  redisUrl: requireEnv('REDIS_URL', 'redis://localhost:6379'),
  databaseUrl: requireEnv(
    'DATABASE_URL',
    'postgresql://claude_queue:claude_queue_dev@localhost:5433/claude_queue',
  ),
  s3Endpoint: requireEnv('S3_ENDPOINT', 'http://localhost:9000'),
  s3AccessKey: requireEnv('S3_ACCESS_KEY'),
  s3SecretKey: requireEnv('S3_SECRET_KEY'),
  s3Bucket: requireEnv('S3_BUCKET', 'claude-queue-attachments'),
  browserHeadless: (process.env['BROWSER_HEADLESS'] ?? 'true') === 'true',
  concurrency: parseInt(process.env['CONCURRENCY'] ?? '1', 10),
};
