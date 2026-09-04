/**
 * Generates an openapi.json file from the NestJS Swagger metadata.
 * Used by CI to lint the spec with @redocly/cli.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/generate-openapi.ts
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

// Stub env before importing AppModule so validators don't throw.
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

async function generate() {
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

  const outPath = resolve(__dirname, '../openapi.json');
  writeFileSync(outPath, JSON.stringify(document, null, 2));
  console.log(`OpenAPI spec written to ${outPath}`);

  await app.close();
}

generate().catch((err) => {
  console.error(err);
  process.exit(1);
});
