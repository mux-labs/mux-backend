import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import requestLogger from './common/middleware/request-logging.middleware';
import { configureBodySizeLimit } from './common/http/body-size-limit';
import { securityHeaders } from './common/http/security-headers';
import { buildCorsOptions } from './common/http/cors';
import { validateEnv } from './config/env.validation';
import { IsoUtcTimestampInterceptor } from './common/interceptors/request-id.interceptor';

/**
 * Application bootstrap.
 *
 * The middleware order below is deliberate and is part of the security
 * posture, so it is documented rather than left implicit:
 *
 *   1. `validateEnv` runs before anything is constructed, so a misconfigured
 *      deployment (missing `WALLET_ENCRYPTION_KEY`, a testnet/mainnet mix-up)
 *      fails closed at boot instead of failing open on the first request.
 *   2. Body-size limiting and security headers are installed before any route
 *      is matched, so an oversized payload is rejected and even a 404 carries
 *      the baseline response headers.
 *   3. CORS is deny-by-default and exact-match only (see `common/http/cors.ts`).
 *   4. The global `/v1` prefix is applied at bootstrap so every controller is
 *      versioned by construction and no unprefixed alias can exist.
 */
async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Validate all required environment variables before anything else starts.
  const env = validateEnv(process.env);

  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Apply the configurable JSON body size limit. Oversized payloads are
  // rejected with a stable 413 error envelope (code + correlation id).
  app.use(configureBodySizeLimit());

  // Baseline security response headers (nosniff, frame denial, referrer
  // policy, ...). Installed before any route so error and 404 responses carry
  // them too. See src/common/http/security-headers.ts.
  app.use(securityHeaders());

  // CORS allowlist. Exact-match only, wildcards rejected, credentials enabled:
  // safe precisely because Access-Control-Allow-Origin is always a specific
  // allowlisted origin and never `*`. See src/common/http/cors.ts.
  app.enableCors(buildCorsOptions(env.CORS_ORIGINS));

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

  // Let Nest call onModuleDestroy/beforeApplicationShutdown on SIGTERM/SIGINT
  // so in-flight requests can finish and connections (Prisma, etc.) close cleanly.
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  logger.log(`Application listening on port ${env.PORT}`);
}

bootstrap();
