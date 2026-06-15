import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Security headers via Helmet
  app.use(helmet());

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
  console.log(`🚀 Claude Queue API running on port ${port}`);
}

bootstrap();
