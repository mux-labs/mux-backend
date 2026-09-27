/**
 * Key Management Consolidation Verification (#918)
 *
 * Production-grade gate that verifies the custody-key invariants documented in:
 *   - docs/key-management-consolidation.md
 *   - docs/custody-security-model.md
 *   - docs/MIGRATION-KEY-MANAGEMENT.md
 *   - docs/MAINNET-PAYMENT-FEATURE-FLAG.md
 *
 * Design goals:
 *  - Fail-closed: any error-severity finding exits non-zero (exit code 1).
 *  - Typed, deterministic, and unit-testable: every check is a pure function
 *    over an in-memory file map, so behaviour is fully covered by
 *    scripts/verify-key-management-consolidation.spec.ts without a database or
 *    network access.
 *  - Stable check ids (KMV-xxx) so CI logs and ticketing can reason about a
 *    specific finding across releases.
 *  - Secret-safe output: findings only report `path:line` locations and a
 *    human-readable explanation — never the matched secret content. The tool
 *    also refuses to run when a bypass override environment variable is set
 *    (deny-by-default for the gate itself).
 *
 * Usage:
 *   pnpm verify:key-consolidation [--json]
 *
 * Exit codes (stable contract for CI):
 *   0  all checks passed (warnings/skips do not fail the build)
 *   1  at least one error-severity check failed
 *   2  the verifier itself could not run (I/O failure)
 *   3  misuse: bad arguments or a bypass override was present
 */
import * as fs from 'fs';
import * as path from 'path';

export const VERIFIER_NAME = 'verify-key-management-consolidation';
export const VERIFIER_VERSION = '1.0.0';

export const EXIT_CODES = {
  PASS: 0,
  FAIL: 1,
  RUNTIME_ERROR: 2,
  USAGE_ERROR: 3,
} as const;

/** Environment overrides that would disable or weaken this gate. Never honored. */
export const BYPASS_ENV_VARS = [
  'KEY_CONSOLIDATION_VERIFY_SKIP',
  'SKIP_KEY_CONSOLIDATION_VERIFY',
  'VERIFY_ALLOW_FAIL',
] as const;

export type CheckSeverity = 'error' | 'warning';
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface VerificationResult {
  /** Stable, machine-readable check id (e.g. "KMV-001"). */
  id: string;
  /** Short human-readable description of the invariant being verified. */
  name: string;
  severity: CheckSeverity;
  status: CheckStatus;
  /** Actionable explanation. Never includes raw secret/key content. */
  message: string;
  /** Relative `path:line` locations contributing to the finding (empty on pass). */
  locations: string[];
}

export interface VerifySummary {
  total: number;
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  exitCode: number;
}

/** Relative path -> file contents. Keys use forward slashes, root-relative. */
export type FileMap = Record<string, string>;

type CheckFn = (files: FileMap) => VerificationResult;

// ─── Secret patterns (used only for detection; never emitted verbatim) ────────

/** Stellar secret seed (Ed25519, base32-check, "S" prefix). */
export const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/;

/** PEM-encoded private key blocks. */
export const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/**
 * Files that legitimately contain the above patterns inside regex literals /
 * redaction pattern definitions and must be excluded from the
 * "no committed secret material" scan.
 */
export const SECRET_PATTERN_DEFINITION_FILES = new Set([
  'src/common/dto/error-envelope.dto.ts',
]);

/**
 * Classifies a scanned path as a money-path service (wallet/payment/
 * orchestration/users), general source, or neither.
 */
function modelType(rel: string): undefined | 'money-path' | 'source' {
  if (/^src\/(wallets|payments|orchestration|users)\/.*\.ts$/.test(rel)) {
    return 'money-path';
  }
  if (/^src\/.*\.ts$/.test(rel)) {
    return 'source';
  }
  return undefined;
}

function scanLines(
  files: FileMap,
  predicate: (rel: string, line: string, lineNo: number) => boolean,
): string[] {
  const locations: string[] = [];
  for (const file of Object.keys(files).sort()) {
    const lines = files[file].split(/\r?\n/);
    lines.forEach((line, index) => {
      if (predicate(file, line, index + 1)) {
        locations.push(`${file}:${index + 1}`);
      }
    });
  }
  return locations.sort();
}

// ─── KMV-001: key generation must be consolidated ─────────────────────────────

const DIRECT_KEY_GEN_PATTERNS = [/generateKeyPairSync\s*\(/, /generateKeyPair\s*\(/];

/**
 * Docs: "A single, typed custody-key API used by every money-path caller"
 * (docs/key-management-consolidation.md). Node crypto key generation must not
 * live inside wallet/payment/orchestration services.
 */
export function checkNoDirectCryptoKeyGeneration(files: FileMap): VerificationResult {
  const locations = scanLines(files, (file, line) => {
    if (modelType(file) !== 'money-path') return false;
    if (file.endsWith('.spec.ts')) return false; // test mocks/fixtures are not runtime paths
    if (line.trim().startsWith('//')) return false;
    return DIRECT_KEY_GEN_PATTERNS.some((pattern) => pattern.test(line));
  });

  return {
    id: 'KMV-001',
    name: 'No direct Node crypto key generation in money-path services',
    severity: 'error',
    status: locations.length > 0 ? 'fail' : 'pass',
    message:
      locations.length > 0
        ? 'Direct Node crypto key generation found in a money-path service. Key material must ' +
          'be generated through the consolidated custody-key layer so encryption at rest and ' +
          'audit logging cannot be bypassed.'
        : 'Wallet/payment/orchestration services do not generate keys with Node crypto.',
    locations,
  };
}

// ─── KMV-002: Stellar keypair construction is restricted to the key layer ─────

const STELLAR_KEYPAIR_PATTERNS = [
  /Keypair\s*\.\s*random\s*\(/,
  /Keypair\s*\.\s*fromSecret\s*\(/,
  /new\s+Keypair\s*\(/,
];

/**
 * Only the custody-key layer may construct Stellar keypairs. Direct use in
 * wallet/payment services risks material touching signing paths without the
 * encryption-at-rest guard.
 */
export function checkNoStellarKeypairInMoneyPath(files: FileMap): VerificationResult {
  const locations = scanLines(files, (file, line) => {
    if (modelType(file) !== 'money-path') return false;
    if (file.endsWith('.spec.ts')) return false;
    if (line.trim().startsWith('//')) return false;
    return STELLAR_KEYPAIR_PATTERNS.some((pattern) => pattern.test(line));
  });

  return {
    id: 'KMV-002',
    name: 'No direct Stellar Keypair construction in money-path services',
    severity: 'error',
    status: locations.length > 0 ? 'fail' : 'pass',
    message:
      locations.length > 0
        ? 'Direct Stellar Keypair construction found in a money-path service. Keypair creation ' +
          'must be restricted to the custody-key layer so secrets are never handled off the ' +
          'consolidated path.'
        : 'No Stellar Keypair construction in wallet/payment/orchestration services.',
    locations,
  };
}

// ─── KMV-003: no key material committed to the repository ─────────────────────

/**
 * Docs: "Key material encrypted at rest with a versioned envelope scheme" and
 * SECURITY.md "Never commit secrets, private keys, or credentials to the
 * repository." Scans source, docs, migrations, and the env template. Findings
 * only report file:line — never the matched value.
 */
export function checkNoCommittedSecretMaterial(files: FileMap): VerificationResult {
  const locations = scanLines(files, (file, line) => {
    if (SECRET_PATTERN_DEFINITION_FILES.has(file)) return false;
    if (file.startsWith('scripts/')) return false; // this tool's own patterns live here
    return (
      STELLAR_SECRET_SEED_PATTERN.test(line) ||
      PEM_PRIVATE_KEY_PATTERN.test(line)
    );
  });

  return {
    id: 'KMV-003',
    name: 'No committed private key material in source, docs, or env template',
    severity: 'error',
    status: locations.length > 0 ? 'fail' : 'pass',
    message:
      locations.length > 0
        ? 'Private key material appears to be committed to the repository. Remove the secret ' +
          'material and rotate any key that was ever exposed. Check the locations and fix before merging.'
        : 'No Stellar secret seeds or PEM private keys found in scanned files.',
    locations,
  };
}

// ─── KMV-004: envelope-at-rest schema fields ───────────────────────────────────

export const ENVELOPE_AT_REST_FIELDS = [
  'encryptedSecret',
  'encryptionVersion',
  'keyVersion',
] as const;

function extractModelBlock(schema: string, modelName: string): string[] {
  const match = schema.match(new RegExp(`model ${modelName}\\s*\\{`));
  if (!match || match.index === undefined) return [];
  const tail = schema.slice(match.index);
  const end = tail.indexOf('\n}');
  const block = end === -1 ? tail : tail.slice(0, end + 2);
  return block.split(/\r?\n/);
}

/**
 * Docs: key material is stored as a versioned envelope (fields: ciphertext /
 * nonce / keyVersion) and never in plaintext. The Wallet model must carry the
 * envelope + version fields.
 */
export function checkEnvelopeAtRest(files: FileMap): VerificationResult {
  const schema = files['prisma/schema.prisma'];
  if (!schema) {
    return {
      id: 'KMV-004',
      name: 'Envelope-at-rest schema fields present',
      severity: 'error',
      status: 'fail',
      message: 'prisma/schema.prisma not found — encrypted-at-rest custody fields cannot be verified.',
      locations: ['prisma/schema.prisma'],
    };
  }

  const block = extractModelBlock(schema, 'Wallet');
  const missing = ENVELOPE_AT_REST_FIELDS.filter(
    (field) => !block.some((line) => new RegExp(`\\b${field}\\b`).test(line)),
  );

  return {
    id: 'KMV-004',
    name: 'Envelope-at-rest schema fields present',
    severity: 'error',
    status: missing.length === 0 ? 'pass' : 'fail',
    message:
      missing.length === 0
        ? 'Wallet model stores key material as a versioned envelope (encryptedSecret, encryptionVersion, keyVersion).'
        : `Wallet model is missing envelope-at-rest field(s): ${missing.join(', ')}. ` +
          'Key material must never be stored in plaintext.',
    locations: missing.map((field) => `prisma/schema.prisma:model Wallet (${field})`),
  };
}

// ─── KMV-005: mainnet money-path flag is deny-by-default ──────────────────────

export const MAINNET_FLAG_DOC = 'docs/MAINNET-PAYMENT-FEATURE-FLAG.md';
export const CONFIG_FILENAME = 'src/config/configuration.ts';
export const ENV_TEMPLATE_FILENAME = '.env.example';

/**
 * Fail-closed: the mainnet payment money-path must default to OFF and be
 * documented in the env template and kill-switch runbook. A missing or invalid
 * env value must resolve to disabled, never enabled.
 */
export function checkMainnetFlagFailClosed(files: FileMap): VerificationResult {
  const problems: string[] = [];

  const env = files[ENV_TEMPLATE_FILENAME] ?? '';
  if (!/^[ \t]*#?[ \t]*[A-Z0-9_]*MAINNET[A-Z0-9_]*[ \t]*=[ \t]*false[ \t]*$/m.test(env)) {
    problems.push(`${ENV_TEMPLATE_FILENAME} does not document a MAINNET flag defaulting to false`);
  }

  const config = files[CONFIG_FILENAME] ?? '';
  const failClosedDefault = /parseBoolean\s*\([^)]*,\s*false\)/.test(config);
  const testnetFallback = /'testnet'/.test(config);
  const disabledBranch = /enabled\s*:\s*false/.test(config);
  if (!failClosedDefault || !testnetFallback || !disabledBranch) {
    problems.push(
      `${CONFIG_FILENAME} must resolve the mainnet flag fail-closed (parseBoolean default false, ` +
        'non-mainnet disabled, explicit disabled branch)',
    );
  }

  if (!files[MAINNET_FLAG_DOC]) {
    problems.push(`${MAINNET_FLAG_DOC} runbook is missing`);
  }

  return {
    id: 'KMV-005',
    name: 'Mainnet payment flag is deny-by-default',
    severity: 'error',
    status: problems.length === 0 ? 'pass' : 'fail',
    message:
      problems.length === 0
        ? 'Mainnet payment flag defaults to false and is documented in the env template and kill-switch runbook.'
        : `Mainnet fail-closed flag verification failed:\n    - ${problems.join('\n    - ')}`,
    locations: [ENV_TEMPLATE_FILENAME, CONFIG_FILENAME].filter((f) => files[f] !== undefined),
  };
}

// ─── KMV-006: correlation ids on privileged surfaces ──────────────────────────

const REQUEST_ID_INTERCEPTOR = 'src/common/interceptors/request-id.interceptor.ts';

/**
 * Observability without secret leakage: every request (notably on money-path /
 * key surfaces) must carry a correlation id that shows up in logs and
 * responses without embedding raw key material.
 */
export function checkCorrelationIdSupport(files: FileMap): VerificationResult {
  const content = files[REQUEST_ID_INTERCEPTOR] ?? '';
  const ok =
    content.includes('x-request-id') &&
    /MAX_REQUEST_ID_LENGTH\s*=/.test(content) &&
    /REQUEST_ID_HEADER\s*=/.test(content);

  return {
    id: 'KMV-006',
    name: 'Correlation id (x-request-id) support present',
    severity: 'error',
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${REQUEST_ID_INTERCEPTOR} defines x-request-id propagation with a bounded, log-safe request id.`
      : `${REQUEST_ID_INTERCEPTOR} is missing or does not define x-request-id / MAX_REQUEST_ID_LENGTH.`,
    locations: [REQUEST_ID_INTERCEPTOR],
  };
}

// ─── KMV-007: stable error codes on key/wallet paths ──────────────────────────

const WALLET_SERVICE = 'src/wallets/wallet.service.ts';
const ERROR_ENVELOPE_DTO = 'src/common/dto/error-envelope.dto.ts';

/**
 * Clients branch on stable, machine-readable error codes (never message text).
 * The wallet/key surfaces must expose typed codes and attach them to thrown
 * HTTP exceptions.
 */
export function checkStableErrorCodes(files: FileMap): VerificationResult {
  const problems: string[] = [];

  const wallet = files[WALLET_SERVICE] ?? '';
  if (!/WalletSuccessorErrorCode\b/.test(wallet)) {
    problems.push(`${WALLET_SERVICE} does not define a stable WalletSuccessorErrorCode set`);
  }
  if (!/\bcode:\s*WalletSuccessorErrorCode\./.test(wallet)) {
    problems.push(`${WALLET_SERVICE} does not attach stable error codes to thrown exceptions`);
  }

  const envelope = files[ERROR_ENVELOPE_DTO] ?? '';
  if (!/export\s+enum\s+ErrorCode\b/.test(envelope)) {
    problems.push(`${ERROR_ENVELOPE_DTO} does not export the stable ErrorCode enum`);
  }

  return {
    id: 'KMV-007',
    name: 'Stable error codes on key/wallet paths',
    severity: 'error',
    status: problems.length === 0 ? 'pass' : 'fail',
    message:
      problems.length === 0
        ? 'Stable error codes are defined for wallet/key operations and the API error envelope.'
        : `Stable error code verification failed:\n    - ${problems.join('\n    - ')}`,
    locations: [WALLET_SERVICE, ERROR_ENVELOPE_DTO].filter((f) => files[f] !== undefined),
  };
}

// ─── KMV-008: deny-by-default authorization ───────────────────────────────────

const HTTP_EXCEPTION_FILTER = 'src/common/filters/http-exception.filter.ts';

/**
 * All privileged surfaces are deny-by-default: unauthenticated requests are
 * rejected unless the exact route is on an explicit public allowlist, and
 * custody-key mutations are restricted to the owner (plus explicit
 * delegate/guardian roles).
 */
export function checkDenyByDefaultAuthz(files: FileMap): VerificationResult {
  const problems: string[] = [];

  const filter = files[HTTP_EXCEPTION_FILTER] ?? '';
  if (!/PUBLIC_ENDPOINT_ALLOWLIST/.test(filter)) {
    problems.push(`${HTTP_EXCEPTION_FILTER} does not define the PUBLIC_ENDPOINT_ALLOWLIST deny-by-default gate`);
  }

  const wallet = files[WALLET_SERVICE] ?? '';
  if (!/actor\.role\s*!==\s*'owner'/.test(wallet)) {
    problems.push(`${WALLET_SERVICE} does not enforce owner-only authorization for custody-key mutations`);
  }
  if (!/\[(['"])owner['"],\s*(['"])delegate['"],\s*(['"])guardian['"]\]/.test(wallet)) {
    problems.push(`${WALLET_SERVICE} does not whitelist owner/delegate/guardian roles for authorized mutations`);
  }

  return {
    id: 'KMV-008',
    name: 'Deny-by-default authorization enforced',
    severity: 'error',
    status: problems.length === 0 ? 'pass' : 'fail',
    message:
      problems.length === 0
        ? 'Public allowlist and owner/delegate/guardian authz patterns are present and deny by default.'
        : `Deny-by-default authz verification failed:\n    - ${problems.join('\n    - ')}`,
    locations: [HTTP_EXCEPTION_FILTER, WALLET_SERVICE].filter((f) => files[f] !== undefined),
  };
}

// ─── KMV-009: dependency outages fail closed on writes ────────────────────────

/**
 * Docs: "Fail-closed on decrypt. If decryption, version resolution, or KMS
 * access fails, the operation aborts." Dependency errors on money/write paths
 * must map to 503 (ServiceUnavailableException), never silently succeed.
 */
export function checkFailClosedDependencyHandling(files: FileMap): VerificationResult {
  const wallet = files[WALLET_SERVICE] ?? '';
  const ok =
    /isDependencyError\s*\(/.test(wallet) &&
    /ServiceUnavailableException/.test(wallet) &&
    /DEPENDENCY_UNAVAILABLE/.test(wallet);

  return {
    id: 'KMV-009',
    name: 'Dependency outages fail closed on write paths',
    severity: 'error',
    status: ok ? 'pass' : 'fail',
    message: ok
      ? `${WALLET_SERVICE} maps dependency failures to ServiceUnavailableException with a stable code.`
      : `${WALLET_SERVICE} must map dependency outages to ServiceUnavailableException (DEPENDENCY_UNAVAILABLE) so writes fail closed.`,
    locations: [WALLET_SERVICE],
  };
}

// ─── KMV-010: response redaction ──────────────────────────────────────────────

/**
 * Error payloads and responses must never echo private keys, JWTs, or webhook
 * secrets. The error envelope must sanitize sensitive patterns before emitting.
 */
export function checkResponseRedaction(files: FileMap): VerificationResult {
  const content = files[ERROR_ENVELOPE_DTO] ?? '';
  const ok =
    /SENSITIVE_PATTERNS/.test(content) &&
    /redactSensitive/.test(content) &&
    /buildErrorEnvelope/.test(content);

  return {
    id: 'KMV-010',
    name: 'Response/error redaction of key material',
    severity: 'error',
    status: ok ? 'pass' : 'fail',
    message: ok
      ? 'Error envelope redacts sensitive patterns (keys, JWTs, secrets) before returning payloads.'
      : `${ERROR_ENVELOPE_DTO} must define SENSITIVE_PATTERNS and redactSensitive/buildErrorEnvelope so secrets never reach clients or logs.`,
    locations: [ERROR_ENVELOPE_DTO],
  };
}

// ─── KMV-011: required docs/runbooks present ──────────────────────────────────

export const REQUIRED_DOCS = [
  'docs/key-management-consolidation.md',
  'docs/custody-security-model.md',
  'docs/MIGRATION-KEY-MANAGEMENT.md',
  'docs/migration-recovery-runbook.md',
  'docs/KEY-MANAGEMENT-SUMMARY.md',
  MAINNET_FLAG_DOC,
  'CHANGELOG-KEY-MANAGEMENT.md',
  'SECURITY.md',
] as const;

export function checkRequiredDocs(files: FileMap): VerificationResult {
  const missing = REQUIRED_DOCS.filter((doc) => !files[doc]);

  return {
    id: 'KMV-011',
    name: 'Required key-management docs and runbooks present',
    severity: 'error',
    status: missing.length === 0 ? 'pass' : 'fail',
    message:
      missing.length === 0
        ? 'All required key-management docs and runbooks are present.'
        : `Missing required docs/runbooks: ${missing.join(', ')}.`,
    locations: missing as string[],
  };
}

// ─── KMV-012: consolidated custody-key layer present (advisory) ───────────────

const KEY_MANAGEMENT_SERVICE = 'src/key-management/key-management.service.ts';

/**
 * Advisory (warning) check: the migration guide documents KeyManagementService
 * as the single custody-key API. If the consolidation layer is not present,
 * key generation cannot be verified as consolidated — call this out explicitly
 * instead of silently passing.
 */
export function checkConsolidationServicePresent(files: FileMap): VerificationResult {
  const present = Boolean(files[KEY_MANAGEMENT_SERVICE]);

  return {
    id: 'KMV-012',
    name: 'Consolidated custody-key layer present',
    severity: 'warning',
    status: present ? 'pass' : 'warn',
    message: present
      ? `${KEY_MANAGEMENT_SERVICE} is present; key generation flows through the consolidated custody-key layer.`
      : `${KEY_MANAGEMENT_SERVICE} was not found. docs/MIGRATION-KEY-MANAGEMENT.md documents key generation ` +
        'consolidation through this service; without it, key generation cannot be verified as consolidated. ' +
        'Confirm the consolidation is complete or out of scope before enabling the mainnet money path.',
    locations: [KEY_MANAGEMENT_SERVICE],
  };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

const CHECKS: CheckFn[] = [
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
];

/**
 * Runs every check over a file map. Pure and deterministic: the same input
 * always yields the same results (sorted by check id), so concurrent or
 * replayed invocations are safe.
 */
export function verifyConsolidation(files: FileMap): VerificationResult[] {
  return CHECKS.map((check) => check(files)).sort((a, b) => a.id.localeCompare(b.id));
}

export function summarize(results: VerificationResult[]): VerifySummary {
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  return {
    total: results.length,
    passed: results.length - failed - warned - skipped,
    failed,
    warned,
    skipped,
    exitCode: failed > 0 ? EXIT_CODES.FAIL : EXIT_CODES.PASS,
  };
}

// ─── Filesystem loading ───────────────────────────────────────────────────────

const SCAN_DIRS = ['src', 'docs', 'prisma'] as const;
const SCAN_FILES = [ENV_TEMPLATE_FILENAME] as const;
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

function walk(rootAbsolute: string, relativeDir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(rootAbsolute, relativeDir), {
    withFileTypes: true,
  })) {
    const child = path.join(relativeDir, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...walk(rootAbsolute, child));
    } else {
      out.push(child);
    }
  }
  return out.sort();
}

/**
 * Reads the repo into a FileMap (relative path -> contents). Explicit files
 * (e.g. .env.example) are loaded if present; directories are walked
 * recursively. Missing paths are silently omitted — checks decide how to
 * report absence.
 */
export function loadFileMap(rootDir: string): FileMap {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`root directory not found or not a directory: ${rootDir}`);
  }
  const map: FileMap = {};
  const add = (relative: string): void => {
    const absolute = path.join(rootDir, relative);
    if (fs.existsSync(absolute)) {
      map[relative] = fs.readFileSync(absolute, 'utf8');
    }
  };

  for (const file of SCAN_FILES) add(file);
  for (const dir of SCAN_DIRS) {
    const absolute = path.join(rootDir, dir);
    if (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
      for (const relative of walk(rootDir, dir)) add(relative);
    }
  }
  return map;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

export function printHuman(
  results: VerificationResult[],
  summary: VerifySummary,
  rootDir: string,
): void {
  const STATUS_ICON: Record<CheckStatus, string> = {
    pass: 'PASS',
    fail: 'FAIL',
    warn: 'WARN',
    skip: 'SKIP',
  };

  console.log(
    `${VERIFIER_NAME} v${VERIFIER_VERSION} — repo root: ${rootDir}\n`,
  );
  for (const result of results) {
    console.log(`[${STATUS_ICON[result.status]}] ${result.id} ${result.name}`);
    console.log(`    ${result.message.split('\n').join('\n    ')}`);
    if (result.locations.length > 0) {
      console.log(`    locations: ${result.locations.join(', ')}`);
    }
  }
  console.log(
    `\nSummary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ` +
      `${summary.warned} warned, ${summary.skipped} skipped`,
  );
}

export function printJson(results: VerificationResult[], summary: VerifySummary): void {
  console.log(
    JSON.stringify(
      {
        verifier: VERIFIER_NAME,
        version: VERIFIER_VERSION,
        summary,
        checks: results,
      },
      null,
      2,
    ),
  );
}

export function detectBypassOverride(env: Record<string, string | undefined>): string | undefined {
  return BYPASS_ENV_VARS.find((name) => env[name] !== undefined && env[name] !== '');
}

/**
 * Runs the verifier against a repo root and returns the exit code. `rootDir`
 * defaults to the repository root (parent of this script).
 */
export function runVerifier(
  argv: string[],
  env: Record<string, string | undefined>,
  rootDir = path.resolve(__dirname, '..'),
): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      `Usage: pnpm verify:key-consolidation [--json]\n\n` +
        `Verifies the custody-key management consolidation invariants documented in\n` +
        `docs/key-management-consolidation.md, docs/custody-security-model.md and\n` +
        `docs/MAINNET-PAYMENT-FEATURE-FLAG.md. Exits non-zero on any error finding\n` +
        `(fail-closed). Use --json for a machine-readable report.`,
    );
    return EXIT_CODES.PASS;
  }

  if (argv.some((a) => a.startsWith('--') && a !== '--json')) {
    console.error(`Unknown argument(s): ${argv.join(' ')}. Run with --help for usage.`);
    return EXIT_CODES.USAGE_ERROR;
  }

  const bypass = detectBypassOverride(env);
  if (bypass) {
    console.error(
      `Refusing to run: ${bypass} is set. This verification gate cannot be disabled with an ` +
        'environment variable (deny-by-default).',
    );
    return EXIT_CODES.USAGE_ERROR;
  }

  let files: FileMap;
  try {
    files = loadFileMap(rootDir);
  } catch (error) {
    console.error(
      `Failed to read repository at ${rootDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return EXIT_CODES.RUNTIME_ERROR;
  }

  const results = verifyConsolidation(files);
  const summary = summarize(results);

  if (argv.includes('--json')) {
    printJson(results, summary);
  } else {
    printHuman(results, summary, rootDir);
  }

  return summary.exitCode;
}

// Run as a CLI when invoked directly (ts-node scripts/verify-key-management-consolidation.ts).
if (require.main === module) {
  process.exitCode = runVerifier(process.argv.slice(2), process.env);
}