import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import requestLogger from './common/middleware/request-logging.middleware';
import { configureBodySizeLimit } from './common/http/body-size-limit';
import { securityHeaders } from './common/http/security-headers';
import { buildCorsOptions } from './common/http/cors';
import { validateEnv } from './config/env.validation';
import { IsoUtcTimestampInterceptor } from './common/interceptors';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import requestLogger from './common/middleware/request-logging.middleware';
import { configureBodySizeLimit } from './common/http/body-size-limit';
import { securityHeaders } from './common/http/security-headers';
import { buildCorsOptions } from './common/http/cors';
import { validateEnv } from './config/env.validation';

/**
 * Application bootstrap.
 *
 * The order of the calls below is load-bearing, so it is spelled out rather
 * than left to the reader:
 *
 * 1. `validateEnv` runs first and **throws** on an invalid environment. This
 *    is the fail-closed gate: a deploy missing `DATABASE_URL`, or carrying the
 *    placeholder encryption key, must never reach `listen()` and serve traffic.
 * 2. `securityHeaders` is installed **before any route** so error responses
 *    and unmatched paths carry the baseline headers too — a 404 that leaks
 *    `X-Powered-By` is still information disclosure (#935).
 * 3. CORS is enabled from `buildCorsOptions`, the single policy that both the
 *    runtime and the `/internal/cors-allowlist` dashboard read (#934).
 * 4. `setGlobalPrefix('v1')` is applied so the documented paths resolve,
 *    including the `/v1/health` and `/v1/health/ready` probes (#933).
 * 5. The global `ValidationPipe` runs `whitelist` + `forbidNonWhitelisted`,
 *    which is what makes the `GET /v1/wallets` query DTO actually reject an
 *    unknown `network`, an out-of-range `limit`, or an unrecognised parameter
 *    at the HTTP boundary instead of passing them through to the query builder
 *    (#936).
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // Fail-closed environment gate. Throws before anything is served.
  const env = validateEnv(process.env);

  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Reject oversized payloads with a stable 413 envelope before any handler
  // runs. Installed ahead of the security headers so a rejected body still
  // carries the baseline response headers.
  app.use(configureBodySizeLimit());

  // Baseline security response headers (#935). Before any route on purpose —
  // see the note above.
  app.use(securityHeaders());

  // Cross-origin policy (#934). `env.CORS_ORIGINS` is already parsed and
  // defaulted by `validateEnv`, so the enforcement path and the allowlist
  // dashboard observe exactly the same list.
  app.enableCors(buildCorsOptions(env.CORS_ORIGINS));

  // Attach request logging early so every later layer can correlate on the
  // same `x-request-id`.
  app.use(requestLogger as never);

  // All routes are served under /v1. See docs/API-VERSIONING.md.
  app.setGlobalPrefix('v1');

  // Validate incoming requests for DTOs globally. This is the enforcement
  // point for the wallet-list filters (#936); the `forbidNonWhitelisted` half
  // is what stops a typo from silently widening a result set.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Normalize all Date values in HTTP responses to ISO 8601 UTC strings.
  app.useGlobalInterceptors(new IsoUtcTimestampInterceptor());

  // Structured error envelope for every failure path, including bootstrap-time
  // validation errors. See test/error-envelope-bootstrap.e2e-spec.ts.
  app.useGlobalFilters(new HttpExceptionFilter());

  // Let Nest call onModuleDestroy/beforeApplicationShutdown on SIGTERM/SIGINT
  // so in-flight requests can finish and connections (Prisma, etc.) close cleanly.
  app.enableShutdownHooks();

  await app.listen(env.PORT);
  logger.log(`Application listening on port ${env.PORT}`);
}

bootstrap().catch((err: unknown) => {
  // Fail-closed bootstrap: if the app cannot start (invalid env, dependency
  // outage, etc.) log a redacted, actionable error and exit non-zero so the
  // orchestrator restarts rather than serving a half-initialized process.
  // Never log raw env values, keys, JWTs, or webhook secrets.
  const message = err instanceof Error ? err.message : String(err);
  new Logger('Bootstrap').error(`Bootstrap failed: ${message}`);
  process.exitCode = 1;
});
