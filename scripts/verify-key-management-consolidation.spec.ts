/**
 * Unit tests for verify-key-management-consolidation.
 *
 * Every check is a pure function over an in-memory FileMap, so these tests
 * exercise all pass/fail/warn paths without touching the real repository.
 * The deterministic interface also guarantees that concurrent or replayed
 * invocations return identical results (idempotency).
 */
import {
  verifyConsolidation,
  summarize,
  runVerifier,
  detectBypassOverride,
  checkNoDirectCryptoKeyGeneration,
  checkNoStellarKeypairInMoneyPath,
  checkNoCommittedSecretMaterial,
  checkEnvelopeAtRest,
  checkMainnetFlagFailClosed,
  checkCorrelationIdSupport,
  checkStableErrorCodes,
  checkDenyByDefaultAuthz,
  checkFailClosedDependencyHandling,
  checkResponseRedaction,
  checkRequiredDocs,
  checkConsolidationServicePresent,
  loadFileMap,
  FileMap,
  VerificationResult,
  EXIT_CODES,
} from './verify-key-management-consolidation';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function passResult(
  check: (f: FileMap) => VerificationResult,
  files: FileMap,
): VerificationResult {
  return check(files);
}

function failOnly(
  results: VerificationResult[],
  ids: string[],
): VerificationResult[] {
  return results.filter((r) => ids.includes(r.id) && r.status === 'fail');
}

// ─── Basic "clean" repo fixture ────────────────────────────────────────────────

const MINIMAL_ENV = `
NODE_ENV=development
DATABASE_URL=postgresql://user:pass@localhost:5432/mux
MAINNET_PAYMENTS_ENABLED=false
`.trimStart();

const MINIMAL_CONFIG = `
export function parseBoolean(v: any, defaultVal: boolean): boolean {
  ...
}
export const resolveMainnetPaymentFlag = (env: any) => {
  const network = 'testnet';
  return { enabled: false, network: 'testnet', denialCode: 'DISABLED' };
};
// Actual function that uses parseBoolean with false default:
function resolveFlag(env: any) {
  const enabled = parseBoolean(env.MAINNET_PAYMENT_ENABLED, false);
  return { enabled: false, network: 'testnet', denialCode: 'DISABLED' };
}
`.trimStart();

const CLEAN_WALLET = `
import { Injectable, ServiceUnavailableException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WalletSuccessorErrorCode } from './wallet-types';

function redactAddress(addr: string): string {
  return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : addr;
}

function isDependencyError(err: any): boolean {
  return err instanceof Error && (err as any).code === 'P1001';
}

@Injectable()
export class WalletService {
  readonly errorCode = WalletSuccessorErrorCode.WALLET_NOT_FOUND;

  register(input: { address: string; correlationId: string; actor: { role: string } }) {
    if (input.actor.role !== 'owner') {
      throw new ForbiddenException({ code: WalletSuccessorErrorCode.NOT_AUTHORIZED, correlationId: input.correlationId });
    }
    // Only authorized roles may advance the successor chain.
    if (!['owner', 'delegate', 'guardian'].includes(input.actor.role)) {
      throw new ForbiddenException({ code: WalletSuccessorErrorCode.NOT_AUTHORIZED });
    }
    if (this.isDependencyError(new Error('DB down'))) {
      throw new ServiceUnavailableException({ code: WalletSuccessorErrorCode.DEPENDENCY_UNAVAILABLE });
    }
  }
}
`.trimStart();

const CLEAN_ERROR_ENVELOPE = `
export enum ErrorCode {
  BAD_REQUEST = 'BAD_REQUEST',
  NOT_FOUND = 'NOT_FOUND',
  FORBIDDEN = 'FORBIDDEN',
}

const SENSITIVE_PATTERNS = [
  /\\bS[A-Z2-7]{55}\\b/,
];

export function redactSensitive(message: string): string {
  let safe = message;
  for (const pat of SENSITIVE_PATTERNS) {
    safe = safe.replace(pat, '[REDACTED]');
  }
  return safe;
}

export interface ErrorEnvelope {
  statusCode: number;
  errorCode: string;
  message: string;
  requestId: string;
}

export function buildErrorEnvelope(statusCode: number, errorCode: string, message: string, requestId: string): ErrorEnvelope {
  return {
    statusCode,
    errorCode,
    message: redactSensitive(message),
    requestId,
  };
}
`.trimStart();

const CLEAN_INTERCEPTOR = `
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';

export const REQUEST_ID_HEADER = 'x-request-id';
export const MAX_REQUEST_ID_LENGTH = 128;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    let id = req.headers[REQUEST_ID_HEADER] as string | undefined;
    if (!id || id.length > MAX_REQUEST_ID_LENGTH || !REQUEST_ID_PATTERN.test(id)) {
      id = randomUUID();
    }
    req[REQUEST_ID_HEADER] = id;
    const res = context.switchToHttp().getResponse();
    res.setHeader(REQUEST_ID_HEADER, id);
    return next.handle();
  }
}
`.trimStart();

const CLEAN_HTTP_FILTER = `
import { ExceptionFilter, Catch, ArgumentsHost, HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

export const AUTH_REQUIRED_ERROR_CODE = 'AUTH_REQUIRED';
export const PUBLIC_ENDPOINT_ALLOWLIST: readonly string[] = [
  '/health',
  '/health/live',
  '/health/ready',
];
`.trimStart();

const MINIMAL_SCHEMA = `
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
  moduleFormat = "cjs"
}
datasource db {
  provider = "postgresql"
}
model Wallet {
  id                String   @id @default(uuid())
  userServiceId     String?
  address           String
  encryptedSecret   String
  encryptionVersion Int      @default(1)
  publicKey         String?
  secretVersion     Int      @default(1)
  keyVersion        Int      @default(1)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
}
`.trimStart();

const MINIMAL_DOCS = [
  'docs/key-management-consolidation.md',
  'docs/custody-security-model.md',
  'docs/MIGRATION-KEY-MANAGEMENT.md',
  'docs/migration-recovery-runbook.md',
  'docs/KEY-MANAGEMENT-SUMMARY.md',
  'docs/MAINNET-PAYMENT-FEATURE-FLAG.md',
  'CHANGELOG-KEY-MANAGEMENT.md',
  'SECURITY.md',
];

function cleanFileMap(extra?: Record<string, string>): FileMap {
  const base: FileMap = {
    '.env.example': MINIMAL_ENV,
    'src/config/configuration.ts': MINIMAL_CONFIG,
    'src/wallets/wallet.service.ts': CLEAN_WALLET,
    'src/common/dto/error-envelope.dto.ts': CLEAN_ERROR_ENVELOPE,
    'src/common/interceptors/request-id.interceptor.ts': CLEAN_INTERCEPTOR,
    'src/common/filters/http-exception.filter.ts': CLEAN_HTTP_FILTER,
    'prisma/schema.prisma': MINIMAL_SCHEMA,
  };
  for (const doc of MINIMAL_DOCS) {
    base[doc] = '# ' + doc.split('/').pop() + '\n\nDocs content.';
  }
  if (extra) {
    Object.assign(base, extra);
  }
  return base;
}

// ─── verifyConsolidation / summarize ───────────────────────────────────────────

describe('verifyConsolidation', () => {
  it('passes all error-severity checks on a clean file map', () => {
    const results = verifyConsolidation(cleanFileMap());
    const fails = results.filter((r) => r.severity === 'error' && r.status === 'fail');
    expect(fails).toEqual([]);
  });

  it('returns deterministic results across two calls (idempotency)', () => {
    const files = cleanFileMap();
    const r1 = verifyConsolidation(files);
    const r2 = verifyConsolidation(files);
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
  });

  it('sorts results by id (stable ordering)', () => {
    const results = verifyConsolidation(cleanFileMap());
    const ids = results.map((r) => r.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual(sorted);
  });

  it('sets correct exit code from summarize: 0 when no failures', () => {
    const results = verifyConsolidation(cleanFileMap());
    const { exitCode } = summarize(results);
    expect(exitCode).toBe(EXIT_CODES.PASS);
  });

  it('sets exit code 1 when errors present', () => {
    // Add a file with direct key generation to cause KMV-001 to fail
    const files = cleanFileMap({
      'src/wallets/bad.service.ts': 'function gen() { generateKeyPairSync("ed25519"); }',
    });
    const results = verifyConsolidation(files);
    const { exitCode } = summarize(results);
    expect(exitCode).toBe(EXIT_CODES.FAIL);
  });

  it('includes 12 checks (KMV-001 through KMV-012)', () => {
    const results = verifyConsolidation(cleanFileMap());
    expect(results).toHaveLength(12);
  });
});

// ─── KMV-001: direct key generation ────────────────────────────────────────────

describe('checkNoDirectCryptoKeyGeneration', () => {
  it('passes when money-path files have no crypto key generation', () => {
    const files = cleanFileMap();
    const result = passResult(checkNoDirectCryptoKeyGeneration, files);
    expect(result.status).toBe('pass');
  });

  it('fails when wallet service has generateKeyPairSync', () => {
    const files = cleanFileMap({
      'src/wallets/some.service.ts':
        'function create(){ generateKeyPairSync("ed25519"); }',
    });
    const result = passResult(checkNoDirectCryptoKeyGeneration, files);
    expect(result.status).toBe('fail');
    expect(result.locations[0]).toContain('src/wallets/some.service.ts');
  });

  it('fails when payments service has generateKeyPair(', () => {
    const files = cleanFileMap({
      'src/payments/pay-key.service.ts': 'await generateKeyPair("x25519");',
    });
    const result = passResult(checkNoDirectCryptoKeyGeneration, files);
    expect(result.status).toBe('fail');
  });

  it('ignores commented lines', () => {
    const files = cleanFileMap({
      'src/wallets/example.ts': '// generateKeyPairSync is not used here',
    });
    const result = passResult(checkNoDirectCryptoKeyGeneration, files);
    expect(result.status).toBe('pass');
  });

  it('ignores .spec.ts files (test mocks are allowed)', () => {
    const files = cleanFileMap({
      'src/wallets/example.spec.ts': 'generateKeyPairSync("ed25519")',
    });
    const result = passResult(checkNoDirectCryptoKeyGeneration, files);
    expect(result.status).toBe('pass');
  });
});

// ─── KMV-002: Stellar Keypair construction in money-path ────────────────────────

describe('checkNoStellarKeypairInMoneyPath', () => {
  it('passes when money-path files have no Keypair construction', () => {
    const files = cleanFileMap();
    const result = passResult(checkNoStellarKeypairInMoneyPath, files);
    expect(result.status).toBe('pass');
  });

  it('fails on Keypair.random() in wallets', () => {
    const files = cleanFileMap({
      'src/wallets/creat-wallet.ts': 'const kp = Keypair.random();',
    });
    const result = passResult(checkNoStellarKeypairInMoneyPath, files);
    expect(result.status).toBe('fail');
  });

  it('fails on Keypair.fromSecret() in payments', () => {
    const files = cleanFileMap({
      'src/payments/sign.ts': 'const kp = Keypair.fromSecret(s);',
    });
    const result = passResult(checkNoStellarKeypairInMoneyPath, files);
    expect(result.status).toBe('fail');
  });

  it('fails on `new Keypair(...)` in a wallet file', () => {
    const files = cleanFileMap({
      'src/wallets/build.ts': 'const kp = new Keypair(raw);',
    });
    const result = passResult(checkNoStellarKeypairInMoneyPath, files);
    expect(result.status).toBe('fail');
  });

  it('ignores .spec.ts files', () => {
    const files = cleanFileMap({
      'src/wallets/build.spec.ts': 'Keypair.random()',
    });
    const result = passResult(checkNoStellarKeypairInMoneyPath, files);
    expect(result.status).toBe('pass');
  });

  it('ignores commented lines', () => {
    const files = cleanFileMap({
      'src/wallets/info.ts': '// Uses Keypair.random() internally',
    });
    const result = passResult(checkNoStellarKeypairInMoneyPath, files);
    expect(result.status).toBe('pass');
  });
});

// ─── KMV-003: no committed secrets ──────────────────────────────────────────────

describe('checkNoCommittedSecretMaterial', () => {
  it('passes clean repo', () => {
    const files = cleanFileMap();
    const result = passResult(checkNoCommittedSecretMaterial, files);
    expect(result.status).toBe('pass');
  });

  it('fails on a Stellar secret seed in source', () => {
    const realSeed = 'SAZSPDOBVOJHDKK5XZ7PRG2G5TNP2QNPM3WTZ3XQ6QV6DJN2765BMUTF';
    const files = cleanFileMap({
      'src/some/file.ts': `const sec = "${realSeed}";`,
    });
    const result = passResult(checkNoCommittedSecretMaterial, files);
    expect(result.status).toBe('fail');
    expect(result.locations[0]).toContain('src/some/file.ts');
  });

  it('fails on a PEM private key block in docs', () => {
    const files = cleanFileMap({
      'docs/examples.md':
        '```\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEII...\n-----BEGIN EC PRIVATE KEY-----\n```',
    });
    const result = passResult(checkNoCommittedSecretMaterial, files);
    expect(result.status).toBe('fail');
  });

  it('skips error-envelope.dto.ts (legitimate pattern definition)', () => {
    const files = cleanFileMap();
    // Add a comment with a seed-like string to error-envelope.dto.ts to prove
    // the file is excluded from the secret scan.
    files['src/common/dto/error-envelope.dto.ts'] =
      CLEAN_ERROR_ENVELOPE + '\n// SABCDEFGHIJKLMNOPQRSTUVWXYZ2345ABCDEFGHIJKLMNOPQRSTUVWXYZ2345A\n';
    const result = passResult(checkNoCommittedSecretMaterial, files);
    expect(result.status).toBe('pass');
  });

  it('does not leak the matched secret in output locations', () => {
    const files = cleanFileMap({
      'src/config/secret.ts': `const secret = "SAZSPDOBVOJHDKK5XZ7PRG2G5TNP2QNPM3WTZ3XQ6QV6DJN2765BMUTF";`,
    });
    const result = passResult(checkNoCommittedSecretMaterial, files);
    expect(result.status).toBe('fail');
    // locations contain "path:line" only, never the matched text
    expect(result.locations.every((loc) => /^[-a-zA-Z0-9_./]+:\d+$/.test(loc))).toBe(true);
    // Ensure the output is clean — no seed value in message or locations
    const output = JSON.stringify(result);
    expect(output).not.toContain('SAZSPDOBVOJHDKK5XZ7PRG2G5TNP2QNPM3WTZ3XQ6QV6DJN2765BMUTF');
  });
});

// ─── KMV-004: envelope at rest ──────────────────────────────────────────────────

describe('checkEnvelopeAtRest', () => {
  it('passes when Wallet model has required envelope fields', () => {
    const files = cleanFileMap();
    const result = passResult(checkEnvelopeAtRest, files);
    expect(result.status).toBe('pass');
  });

  it('fails when schema is missing', () => {
    const files = cleanFileMap();
    delete files['prisma/schema.prisma'];
    const result = passResult(checkEnvelopeAtRest, files);
    expect(result.status).toBe('fail');
  });

  it('fails when encryptedSecret is missing from Wallet', () => {
    const schema = MINIMAL_SCHEMA.replace('encryptedSecret   String', 'deprecatedField String');
    const files = cleanFileMap({ 'prisma/schema.prisma': schema });
    const result = passResult(checkEnvelopeAtRest, files);
    expect(result.status).toBe('fail');
    expect(result.message).toContain('encryptedSecret');
  });
});

// ─── KMV-005: mainnet flag ──────────────────────────────────────────────────────

describe('checkMainnetFlagFailClosed', () => {
  it('passes with documented mainnet flag and fail-closed resolver', () => {
    const files = cleanFileMap();
    const result = passResult(checkMainnetFlagFailClosed, files);
    expect(result.status).toBe('pass');
  });

  it('fails when .env.example lacks MAINNET=false default', () => {
    const files = cleanFileMap({ '.env.example': 'NODE_ENV=development\n' });
    const result = passResult(checkMainnetFlagFailClosed, files);
    expect(result.status).toBe('fail');
  });

  it('fails when config does not pass false default to parseBoolean', () => {
    const files = cleanFileMap({
      'src/config/configuration.ts': `
        export function resolveMainnetPaymentFlag() {
          const enabled = parseBoolean(process.env.MAINNET_PAYMENT_ENABLED, true); // dangerous default!
          return { enabled, network: 'mainnet', denialCode: 'DISABLED' };
        }
      `.trimStart(),
    });
    const result = passResult(checkMainnetFlagFailClosed, files);
    expect(result.status).toBe('fail');
  });

  it('fails when runbook doc is missing', () => {
    const files = cleanFileMap();
    delete files['docs/MAINNET-PAYMENT-FEATURE-FLAG.md'];
    const result = passResult(checkMainnetFlagFailClosed, files);
    expect(result.status).toBe('fail');
  });
});

// ─── KMV-006: correlation ids ───────────────────────────────────────────────────

describe('checkCorrelationIdSupport', () => {
  it('passes with x-request-id interceptor', () => {
    const files = cleanFileMap();
    const result = passResult(checkCorrelationIdSupport, files);
    expect(result.status).toBe('pass');
  });

  it('fails when interceptor is missing', () => {
    const files = cleanFileMap();
    delete files['src/common/interceptors/request-id.interceptor.ts'];
    const result = passResult(checkCorrelationIdSupport, files);
    expect(result.status).toBe('fail');
  });

  it('fails when header constant is not x-request-id', () => {
    const files = cleanFileMap({
      'src/common/interceptors/request-id.interceptor.ts':
        "export const REQUEST_ID_HEADER = 'x-correlation-id';\n",
    });
    const result = passResult(checkCorrelationIdSupport, files);
    expect(result.status).toBe('fail');
  });
});

// ─── KMV-007: stable error codes ────────────────────────────────────────────────

describe('checkStableErrorCodes', () => {
  it('passes with WalletSuccessorErrorCode and ErrorCode enum', () => {
    const files = cleanFileMap();
    const result = passResult(checkStableErrorCodes, files);
    expect(result.status).toBe('pass');
  });

  it('fails when wallet service lacks error codes', () => {
    const files = cleanFileMap({
      'src/wallets/wallet.service.ts': '// no error codes here',
    });
    const result = passResult(checkStableErrorCodes, files);
    expect(result.status).toBe('fail');
  });
});

// ─── KMV-008: deny-by-default authz ─────────────────────────────────────────────

describe('checkDenyByDefaultAuthz', () => {
  it('passes with PUBLIC_ENDPOINT_ALLOWLIST and role checks', () => {
    const files = cleanFileMap();
    const result = passResult(checkDenyByDefaultAuthz, files);
    expect(result.status).toBe('pass');
  });

  it('fails when PUBLIC_ENDPOINT_ALLOWLIST is missing', () => {
    const files = cleanFileMap({
      'src/common/filters/http-exception.filter.ts': '// no allowlist',
    });
    const result = passResult(checkDenyByDefaultAuthz, files);
    expect(result.status).toBe('fail');
  });
});

// ─── KMV-009: fail-closed dependency handling ───────────────────────────────────

describe('checkFailClosedDependencyHandling', () => {
  it('passes with isDependencyError and ServiceUnavailableException', () => {
    const files = cleanFileMap();
    const result = passResult(checkFailClosedDependencyHandling, files);
    expect(result.status).toBe('pass');
  });

  it('fails when wallet service lacks isDependencyError', () => {
    const files = cleanFileMap({
      'src/wallets/wallet.service.ts': '@Injectable()\nexport class WalletService {\n  // no dependency checks\n}',
    });
    const result = passResult(checkFailClosedDependencyHandling, files);
    expect(result.status).toBe('fail');
  });
});

// ─── KMV-010: response redaction ────────────────────────────────────────────────

describe('checkResponseRedaction', () => {
  it('passes with SENSITIVE_PATTERNS and redactSensitive', () => {
    const files = cleanFileMap();
    const result = passResult(checkResponseRedaction, files);
    expect(result.status).toBe('pass');
  });

  it('fails when redaction is absent', () => {
    const files = cleanFileMap({
      'src/common/dto/error-envelope.dto.ts':
        'export class SomeClass {}\n',
    });
    const result = passResult(checkResponseRedaction, files);
    expect(result.status).toBe('fail');
  });
});

// ─── KMV-011: required docs ─────────────────────────────────────────────────────

describe('checkRequiredDocs', () => {
  it('passes when all required docs exist', () => {
    const files = cleanFileMap();
    const result = passResult(checkRequiredDocs, files);
    expect(result.status).toBe('pass');
  });

  it('fails when one doc is missing', () => {
    const files = cleanFileMap();
    delete files['docs/custody-security-model.md'];
    const result = passResult(checkRequiredDocs, files);
    expect(result.status).toBe('fail');
    expect(result.locations).toContain('docs/custody-security-model.md');
  });
});

// ─── KMV-012: consolidation service present (advisory) ─────────────────────────

describe('checkConsolidationServicePresent', () => {
  it('warns when key-management service is absent', () => {
    const files = cleanFileMap();
    const result = passResult(checkConsolidationServicePresent, files);
    expect(result.status).toBe('warn');
    expect(result.severity).toBe('warning');
    expect(result.message).toContain('not found');
  });

  it('passes when key-management service is present', () => {
    const files = cleanFileMap({
      'src/key-management/key-management.service.ts':
        'export class KeyManagementService { generateKey() { return "ok"; } }',
    });
    const result = passResult(checkConsolidationServicePresent, files);
    expect(result.status).toBe('pass');
  });
});

// ─── runVerifier (CLI integration) ──────────────────────────────────────────────

describe('runVerifier', () => {
  // We test CLI-level concerns: exit codes, bypass overrides, help output.
  // Each call passes an explicit rootDir so behaviour is independent of the
  // repository layout in CI.

  it('returns PASS for --help', () => {
    const code = runVerifier(['--help'], {}, __dirname);
    expect(code).toBe(EXIT_CODES.PASS);
  });

  it('returns USAGE_ERROR for unknown flags', () => {
    const code = runVerifier(['--magic-mode'], {}, __dirname);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
  });

  it('returns USAGE_ERROR when bypass override env is set', () => {
    const code = runVerifier([], { KEY_CONSOLIDATION_VERIFY_SKIP: '1' }, __dirname);
    expect(code).toBe(EXIT_CODES.USAGE_ERROR);
  });

  it('returns RUNTIME_ERROR on unreadable rootDir', () => {
    const code = runVerifier([], {}, '/nonexistent/path/12345678/xyz');
    expect(code).toBe(EXIT_CODES.RUNTIME_ERROR);
  });
});

// ─── detectBypassOverride ───────────────────────────────────────────────────────

describe('detectBypassOverride', () => {
  it('returns undefined when no override is set', () => {
    expect(detectBypassOverride({})).toBeUndefined();
    expect(detectBypassOverride({ PATH: '/usr/bin' })).toBeUndefined();
  });

  it('returns the var name when a bypass var is set', () => {
    expect(detectBypassOverride({ SKIP_KEY_CONSOLIDATION_VERIFY: '1' })).toBe(
      'SKIP_KEY_CONSOLIDATION_VERIFY',
    );
  });

  it('returns undefined when bypass var is set to empty string', () => {
    expect(detectBypassOverride({ KEY_CONSOLIDATION_VERIFY_SKIP: '' })).toBeUndefined();
  });
});

// ─── summarize ──────────────────────────────────────────────────────────────────

describe('summarize', () => {
  it('counts warn status correctly', () => {
    const results: VerificationResult[] = [
      { id: 'A', name: 'a', severity: 'warning', status: 'warn', message: '', locations: [] },
      { id: 'B', name: 'b', severity: 'error', status: 'pass', message: '', locations: [] },
    ];
    const s = summarize(results);
    expect(s.failed).toBe(0);
    expect(s.warned).toBe(1);
    expect(s.passed).toBe(1);
    expect(s.exitCode).toBe(EXIT_CODES.PASS);
  });

  it('fails the build when any error-severity check fails', () => {
    const results: VerificationResult[] = [
      { id: 'X', name: 'x', severity: 'error', status: 'fail', message: '', locations: [] },
      { id: 'Y', name: 'y', severity: 'error', status: 'pass', message: '', locations: [] },
    ];
    const s = summarize(results);
    expect(s.failed).toBe(1);
    expect(s.exitCode).toBe(EXIT_CODES.FAIL);
  });

  it('counts skip status', () => {
    const results: VerificationResult[] = [
      { id: 'A', name: 'a', severity: 'error', status: 'skip', message: '', locations: [] },
    ];
    const s = summarize(results);
    expect(s.skipped).toBe(1);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
  });
});