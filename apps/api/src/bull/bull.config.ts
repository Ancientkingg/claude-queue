import type { ConnectionOptions } from 'bullmq';

export const QUEUE_NAME = 'claude-queue';

export function getRedisConnection(): ConnectionOptions {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const url = new URL(redisUrl);

  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
  };
}
