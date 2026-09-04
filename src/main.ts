import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import requestLogger from './common/middleware/request-logging.middleware';
import { configureBodySizeLimit } from './common/http/body-size-limit';
import { validateEnv } from './config/env.validation';
import { IsoUtcTimestampInterceptor } from './common/interceptors';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Validate all required environment variables before anything else starts.
  const env = validateEnv(process.env);

  const app = await NestFactory.create(AppModule, { bodyParser: false });

  configureBodySizeLimit(app, env.JSON_BODY_LIMIT_BYTES);

  // Configure CORS with credentials support
  // Only allow credentials when explicitly whitelisted origins are used.
  // CORS_ORIGINS is validated (comma-separated list of http/https URLs) in
  // src/config/env.validation.ts, defaulting to http://localhost:3000.
  const corsOrigins = env.CORS_ORIGINS;
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'), false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-API-Key',
      'X-Request-ID',
      'X-Client-Version',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
    maxAge: 3600,
  });

  // Attach request logging middleware early in the pipeline
  app.use(requestLogger as any);

  // All routes are served under /v1. See docs/API-VERSIONING.md for the
  // versioning strategy and how future breaking changes will be introduced.
  app.setGlobalPrefix('v1');

  // Validate incoming requests for DTOs globally
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Normalize all Date values in HTTP responses to ISO 8601 UTC strings.
  app.useGlobalInterceptors(new IsoUtcTimestampInterceptor());

  // Apply global exception filter for structured error responses
  app.useGlobalFilters(new HttpExceptionFilter());

  // Let Nest call onModuleDestroy/beforeApplicationShutdown on SIGTERM/SIGINT
  // so in-flight requests can finish and connections (Prisma, etc.) close cleanly.
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  logger.log(`Application listening on port ${env.PORT}`);
}

bootstrap();
