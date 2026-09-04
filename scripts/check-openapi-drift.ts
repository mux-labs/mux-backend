/**
 * #786 — OpenAPI Drift Check
 *
 * Generates a fresh OpenAPI spec from the live NestJS routes and diffs it
 * against the committed `openapi.json`.  Exits non-zero (failing CI) when
 * the two differ so that controllers and DTOs cannot silently drift from the
 * published spec.
 *
 * Usage:
 *   pnpm run openapi:check-drift
 *
 * It is safe to run without a real database — the same env stubs used by
 * generate-openapi.ts are applied here.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ─── Stub env so AppModule validators don't throw ────────────────────────────
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://stub:stub@localhost:5432/stub';
process.env.WALLET_ENCRYPTION_KEY =
  process.env.WALLET_ENCRYPTION_KEY ?? '0'.repeat(64);
process.env.STELLAR_HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
process.env.STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? 'TESTNET';
process.env.STELLAR_HORIZON_TESTNET_URL =
  process.env.STELLAR_HORIZON_TESTNET_URL ??
  'https://horizon-testnet.stellar.org';
process.env.STELLAR_HORIZON_MAINNET_URL =
  process.env.STELLAR_HORIZON_MAINNET_URL ?? 'https://horizon.stellar.org';
process.env.STELLAR_HORIZON_MAX_RETRIES =
  process.env.STELLAR_HORIZON_MAX_RETRIES ?? '3';
process.env.STELLAR_HORIZON_RETRY_BACKOFF_MS =
  process.env.STELLAR_HORIZON_RETRY_BACKOFF_MS ?? '500';
process.env.STELLAR_HORIZON_RETRY_JITTER_MS =
  process.env.STELLAR_HORIZON_RETRY_JITTER_MS ?? '250';
process.env.BALANCE_STALE_THRESHOLD_MS =
  process.env.BALANCE_STALE_THRESHOLD_MS ?? '300000';
process.env.WEBHOOK_MAX_RETRIES = process.env.WEBHOOK_MAX_RETRIES ?? '5';
process.env.WEBHOOK_RETRY_BACKOFF_MS =
  process.env.WEBHOOK_RETRY_BACKOFF_MS ?? '1000';
process.env.WEBHOOK_TIMEOUT_MS = process.env.WEBHOOK_TIMEOUT_MS ?? '10000';
process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES =
  process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES ?? '10';
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX ?? '10';
process.env.AUTH_RATE_LIMIT_WINDOW_MS =
  process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../src/app.module');

async function checkDrift() {
  const committedPath = resolve(__dirname, '../openapi.json');

  if (!existsSync(committedPath)) {
    console.error(
      `\n[openapi:check-drift] ERROR: committed spec not found at ${committedPath}\n` +
        `Run "pnpm run openapi:generate" first and commit the result.\n`,
    );
    process.exit(1);
  }

  // Generate fresh spec from live routes
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('v1');

  const config = new DocumentBuilder()
    .setTitle('Mux Backend API')
    .setDescription('Wallet, payment, and custody API for mux-backend')
    .setVersion('1.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')
    .addGlobalParameters({
      name: 'X-Client-Version',
      in: 'header',
      required: false,
      description:
        'Optional client application version (e.g. "2.4.1"). Included in support logs to help triage wallet/payment/custody issues by reporting client version. Missing or malformed values are ignored and do not affect the request.',
      schema: { type: 'string' },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);
  await app.close();

  const fresh = JSON.stringify(document, null, 2);
  const committed = readFileSync(committedPath, 'utf-8');

  if (fresh === committed) {
    console.log('[openapi:check-drift] ✅  No drift detected — spec is up to date.');
    process.exit(0);
  }

  // Produce a human-readable diff summary: show which top-level paths changed.
  let committedDoc: Record<string, unknown>;
  try {
    committedDoc = JSON.parse(committed) as Record<string, unknown>;
  } catch {
    console.error('[openapi:check-drift] ERROR: committed openapi.json is not valid JSON.');
    process.exit(1);
  }

  const freshPaths = new Set(Object.keys((document as any).paths ?? {}));
  const committedPaths = new Set(
    Object.keys((committedDoc as any).paths ?? {}),
  );

  const added = [...freshPaths].filter((p) => !committedPaths.has(p));
  const removed = [...committedPaths].filter((p) => !freshPaths.has(p));

  console.error('\n[openapi:check-drift] ❌  OpenAPI spec has drifted from committed file!');
  if (added.length > 0) {
    console.error('\nPaths present in routes but MISSING from committed spec:');
    added.forEach((p) => console.error(`  + ${p}`));
  }
  if (removed.length > 0) {
    console.error('\nPaths in committed spec but NO LONGER in routes:');
    removed.forEach((p) => console.error(`  - ${p}`));
  }
  if (added.length === 0 && removed.length === 0) {
    console.error('\n(No path additions/removals — likely a schema or decorator change.)');
  }
  console.error(
    '\nFix: run "pnpm run openapi:generate" locally, review the diff, and commit the updated openapi.json.\n',
  );
  process.exit(1);
}

checkDrift().catch((err) => {
  console.error('[openapi:check-drift] Unexpected error:', err);
  process.exit(1);
});
