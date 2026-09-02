import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { AppModule } from './app.module.js';
import { createLogger, httpLoggerOptions } from './common/logger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const isProduction = config.getOrThrow<boolean>('isProduction');

  const logger = createLogger(config.getOrThrow<string>('logLevel'), !isProduction);
  app.use(pinoHttp(httpLoggerOptions(logger)));

  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cookieParser());
  // Behind Nginx or Caddy, req.ip must come from X-Forwarded-For or every
  // rate limit and audit entry records the proxy's address instead.
  app.set('trust proxy', 1);

  app.enableCors({
    origin: config.getOrThrow<string[]>('corsOrigins'),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  if (!isProduction) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('ManagedOps API')
        .setDescription('Workforce operations for training delivery')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  app.enableShutdownHooks();

  const port = config.getOrThrow<number>('port');
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`ManagedOps API listening on :${port}`);
}

bootstrap().catch((error: unknown) => {
  // Nothing is listening yet, so this has to reach stderr directly.
  console.error('ManagedOps API failed to start:', error);
  process.exit(1);
});
