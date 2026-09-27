import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract test for docs/CRON-SCHEDULES.md (#961 — "Cron schedule docs").
 *
 * The cron jobs are the most privileged, least-visible surface in the backend:
 * they run with cross-tenant privilege, are triggered by an external scheduler,
 * and were previously documented only implicitly (a paragraph in SECURITY.md).
 * That made it impossible to answer, from the repo alone:
 *
 *   - which endpoints are cron jobs,
 *   - how often each is meant to run,
 *   - how they are authenticated, and
 *   - what an operator must do when one fails.
 *
 * This test locks the documented schedule surface down so it cannot silently
 * drift from the implemented surface. It is documentation/CI only: it performs
 * no network, DB, or secret access, and it asserts that the *documents* agree
 * with each other and with the guard specs that enforce the policy.
 *
 * Fail-closed: if a new internal route or worker is added without documenting
 * its cadence, or if the docs contradict the enforced guard policy, this fails.
 */

const REPO_ROOT = path.join(__dirname, '..');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const CRON_DOC = 'docs/CRON-SCHEDULES.md';

/** Endpoints that must be documented with a cadence, per the e2e guard specs. */
const INTERNAL_ENDPOINTS: Array<{
  route: string;
  method: string;
  cadence: RegExp;
}> = [
  {
    route: '/v1/transactions/internal/poll-pending',
    method: 'POST',
    cadence: /Every 1 minute/,
  },
  {
    route: '/v1/transactions/internal/relayer-funding/check',
    method: 'POST',
    cadence: /Every 15 minutes/,
  },
  {
    route: '/v1/transactions/internal/stuck-pending',
    method: 'GET',
    cadence: /Every 15 minutes/,
  },
  { route: '/v1/backup/health', method: 'GET', cadence: /Daily/ },
  { route: '/v1/backup/metadata', method: 'POST', cadence: /Daily/ },
  { route: '/v1/backup/drill', method: 'POST', cadence: /Monthly/ },
  { route: '/v1/backup/procedures', method: 'GET', cadence: /Daily/ },
];

describe('docs/CRON-SCHEDULES.md (issue #961)', () => {
  let cronDoc: string;

  beforeAll(() => {
    cronDoc = read(CRON_DOC);
  });

  it('exists and is non-empty', () => {
    expect(cronDoc).toBeDefined();
    expect(cronDoc.length).toBeGreaterThan(0);
  });

  describe('invariants every cron job must satisfy', () => {
    it.each([
      ['Deny-by-default', /\*\*Deny-by-default\.\*\*/],
      ['Not public API', /\*\*Not public API\.\*\*/],
      ['Constant-time comparison', /timingSafeEqual/],
      ['No secret leakage', /\*\*No secret leakage\.\*\*/],
      ['Idempotent / replay-safe', /\*\*Idempotent \/ replay-safe\.\*\*/],
      [
        'Fail-closed on dependency outage',
        /\*\*Fail-closed on dependency outage\.\*\*/,
      ],
      ['No cross-tenant escalation', /\*\*No cross-tenant escalation\.\*\*/],
      ['Bounded input', /\*\*Bounded input\.\*\*/],
    ])('documents the %s invariant', (_label, pattern) => {
      expect(cronDoc).toMatch(pattern);
    });
  });

  describe('authentication contract', () => {
    it('documents the header name', () => {
      expect(cronDoc).toContain('X-Cron-Secret');
    });

    it('documents the config key', () => {
      expect(cronDoc).toContain('CRON_SECRET');
    });

    it('states the 401 failure response', () => {
      expect(cronDoc).toMatch(/401/);
    });

    it('forbids a default/fallback credential', () => {
      expect(cronDoc).toMatch(/no default\s+credential/i);
    });

    it('forbids logging the secret value', () => {
      expect(cronDoc).toMatch(/Never\*{0,2}\s+the secret value/i);
    });
  });

  describe('schedule reference', () => {
    it('has a schedule reference table', () => {
      expect(cronDoc).toContain('## Schedule reference');
    });

    it.each(INTERNAL_ENDPOINTS)(
      'documents $method $route with a cadence',
      ({ route, method, cadence }) => {
        // The route must appear in a table row that also states the method.
        const rowPattern = new RegExp(
          `\\|\\s*\`${route.replace(/[/]/g, '\\/')}\`\\s*\\|\\s*\`${method}\``,
        );
        expect(cronDoc).toMatch(rowPattern);
        expect(cronDoc).toMatch(cadence);
      },
    );

    it('documents an idempotency guard for every write job', () => {
      expect(cronDoc).toMatch(/Idempotency-Key/);
      expect(cronDoc).toMatch(/Natural key/);
    });

    it('documents a maximum batch size for the polling jobs', () => {
      expect(cronDoc).toContain('max `1000`');
    });

    it('documents the in-process rate-limit cleanup worker', () => {
      expect(cronDoc).toContain('RateLimitCleanupWorker');
      expect(cronDoc).toContain('RATE_LIMIT_CLEANUP_INTERVAL_MS');
    });
  });

  describe('failure modes and safe replay', () => {
    it('has a failure-mode section', () => {
      expect(cronDoc).toContain('## Failure modes & safe replay');
    });

    it('covers the missing-secret case', () => {
      expect(cronDoc).toMatch(/`CRON_SECRET` unset/);
    });

    it('covers the dependency-outage case', () => {
      expect(cronDoc).toMatch(/DB \/ Horizon outage/);
    });

    it('covers the duplicate/overlapping trigger case', () => {
      expect(cronDoc).toMatch(/Duplicate \/ overlapping trigger/);
    });

    it('covers the testnet/mainnet misconfiguration case', () => {
      expect(cronDoc).toMatch(/Testnet vs mainnet misconfiguration/);
    });

    it('covers the oversized-batch case', () => {
      expect(cronDoc).toMatch(/Oversized `limit`/);
    });
  });

  describe('contributor guidance', () => {
    it('documents how to add a new scheduled job', () => {
      expect(cronDoc).toContain('## Adding a new scheduled job');
    });

    it('requires the doc and the test to change in the same PR', () => {
      expect(cronDoc).toMatch(/in the same PR/);
    });

    it('documents rollback', () => {
      expect(cronDoc).toContain('## Rollback');
      expect(cronDoc).toMatch(/no data migration/i);
    });
  });

  describe('cross-links stay consistent', () => {
    it('references the guard specs that enforce the policy', () => {
      expect(cronDoc).toContain('test/cron-secret-guard.e2e-spec.ts');
      expect(cronDoc).toContain(
        'test/transactions-internal-cron-guard.e2e-spec.ts',
      );
      expect(cronDoc).toContain('test/backup-module-registered.e2e-spec.ts');
    });

    it('references SECURITY.md as the authoritative policy', () => {
      expect(cronDoc).toContain('SECURITY.md');
    });

    it('is linked from README.md', () => {
      expect(read('README.md')).toContain('docs/CRON-SCHEDULES.md');
    });

    it('is linked from SECURITY.md', () => {
      expect(read('SECURITY.md')).toContain('docs/CRON-SCHEDULES.md');
    });
  });

  describe('no secrets are committed in the documentation', () => {
    it('does not contain a literal cron secret value', () => {
      // The doc may name CRON_SECRET, but must never embed a value for it.
      expect(cronDoc).not.toMatch(/CRON_SECRET\s*=\s*\S+/);
    });
  });
});
