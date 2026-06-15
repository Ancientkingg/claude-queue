import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  // Security headers via Helmet
  app.use(helmet());

  // Request logging middleware
  app.use((req: any, res: any, next: any) => {
    const start = Date.now();
    const { method, originalUrl } = req;
    res.on('finish', () => {
      const duration = Date.now() - start;
      const { statusCode } = res;
      logger.log(`${method} ${originalUrl} ${statusCode} ${duration}ms`);
    });
    next();
  });

  // CORS: restrict to the extension's origin. In production, set ALLOWED_ORIGINS env var.
  const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map((s) => s.trim()) ?? [];
  app.enableCors({
    origin: allowedOrigins.length > 0
      ? allowedOrigins
      : [
          // Browser extension origins
          'moz-extension://*',
          'chrome-extension://*',
        ],
    methods: ['GET', 'POST'],
    maxAge: 86400,
  });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`🚀 Claude Queue API running on port ${port}`);
  logger.log(`📋 Health check: http://localhost:${port}/health`);
  logger.log(`🗄️  Database: ${process.env.DATABASE_URL ? 'configured' : '⚠️  NOT SET'}`);
  logger.log(`📡 Redis: ${process.env.REDIS_URL || 'redis://localhost:6379'}`);
  logger.log(`📦 S3: ${process.env.S3_ENDPOINT || 'http://localhost:9000'}`);
}

bootstrap().catch((err) => {
  console.error('❌ Failed to start API:', err);
  process.exit(1);
});
