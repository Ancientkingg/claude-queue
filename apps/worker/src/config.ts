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
  /** Maximum attempts per job before marking it FAILED (BullMQ retries). */
  maxAttempts: number;
  /** Backoff delay in ms between retries (exponential, this is the base). */
  retryBaseMs: number;
  /** Time to wait for a Turnstile challenge to auto-resolve before calling solver. */
  challengeAutoResolveMs: number;
  /** Timeout for the external CAPTCHA solving service. */
  captchaSolverTimeoutMs: number;
  /** Base URL of the FlareSolverr instance (e.g. http://localhost:8191). */
  flareSolverrUrl: string;
  /** Optional proxy URL for FlareSolverr's own browser (different from the Playwright proxy). */
  flareSolverrProxy?: string;
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
  s3AccessKey: requireEnv('S3_ACCESS_KEY', 'minioadmin'),
  s3SecretKey: requireEnv('S3_SECRET_KEY', 'minioadmin'),
  s3Bucket: requireEnv('S3_BUCKET', 'claude-queue-attachments'),
  browserHeadless: (process.env['BROWSER_HEADLESS'] ?? 'true') === 'true',
  concurrency: parseInt(process.env['CONCURRENCY'] ?? '1', 10),
  maxAttempts: parseInt(process.env['MAX_ATTEMPTS'] ?? '3', 10),
  retryBaseMs: parseInt(process.env['RETRY_BASE_MS'] ?? '5000', 10),
  challengeAutoResolveMs: parseInt(process.env['CHALLENGE_AUTO_RESOLVE_MS'] ?? '15000', 10),
  captchaSolverTimeoutMs: parseInt(process.env['CAPTCHA_SOLVER_TIMEOUT_MS'] ?? '120000', 10),
  flareSolverrUrl: (process.env['FLARESOLVERR_URL'] ?? 'http://localhost:8191').replace(/\/+$/, ''),
  flareSolverrProxy: process.env['FLARESOLVERR_PROXY']?.trim() || undefined,
};
