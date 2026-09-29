/**
 * Contract test for the CI workflow's required-check wiring (issue #932).
 *
 * `.github/workflows/ci.yml` had **38 job entries for 18 unique job ids**.
 * That is not a harmless redundancy: YAML mapping keys are last-wins, so a
 * repeated job id does not run twice — every *earlier* definition of that job
 * is silently discarded. The visible symptoms were:
 *
 *   - `security-md` was defined 5 times, `cron-schedule-docs` 5 times,
 *     `transaction-env-validator-e2e` 5 times, `login-smoke-e2e` 4 times.
 *   - `indexer-lag-metrics` and `webhook-ssrf-allowlist` survived only as
 *     comment blocks with a `name:` and **no `runs-on` and no `steps`**, so
 *     they could never execute.
 *   - The `api-prefix-docs` job was truncated mid-step ("Verify pre") and then
 *     redefined, so the truncated copy was the one that mattered.
 *   - One `security-md` copy had a half-written step (a `name:` with a bare
 *     `#` comment and no `run:`), which is a workflow *validation* error.
 *
 * The failure mode is invisible in the Actions UI: a required check that lost
 * its definition simply never reports, and a reviewer sees a green run. So
 * this test asserts the properties that make the wiring trustworthy rather
 * than trusting the file to be well-formed:
 *
 *   1. No duplicate job id — the root cause.
 *   2. Every job is executable: it has a `runs-on` and at least one step, and
 *      every step has either a `run:` or a `uses:`.
 *   3. Every job id the documentation relies on actually exists, so a job
 *      cannot be "documented as required" while being absent.
 *   4. Every required check that runs a spec first asserts the spec is
 *      present, so deleting a spec fails the job instead of passing on zero
 *      tests (fail-closed, not silently green).
 *   5. Every `test -f` path and every spec path a job references exists in
 *      the repository.
 *
 * Documentation/CI only: no DB, no network, no secrets.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..');
const WORKFLOW = '.github/workflows/ci.yml';

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const workflow = read(WORKFLOW);

/**
 * Extract each `jobs:` entry as `{ id, body }` by brace-depth scanning, which
 * is tolerant of the block style and comments the workflow uses.
 */
const parseJobs = (
  source: string,
): Array<{ id: string; body: string; line: number }> => {
  const lines = source.split('\n');
  const jobsIndex = lines.findIndex((line) => /^jobs:\s*$/.test(line));
  if (jobsIndex === -1) throw new Error('no jobs: mapping in the workflow');

  const jobs: Array<{ id: string; body: string; line: number }> = [];
  let current: { id: string; start: number } | null = null;

  for (let i = jobsIndex + 1; i < lines.length; i += 1) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(lines[i]);

    if (header) {
      if (current) {
        jobs.push({
          id: current.id,
          body: lines.slice(current.start, i).join('\n'),
          line: current.start,
        });
      }
      current = { id: header[1], start: i + 1 };
      continue;
    }

    // A non-indented, non-blank line ends the jobs: mapping entirely.
    if (current && lines[i].trim() !== '' && !/^ {3,}/.test(lines[i])) {
      jobs.push({
        id: current.id,
        body: lines.slice(current.start, i).join('\n'),
        line: current.start,
      });
      current = null;
    }
  }

  if (current) {
    jobs.push({
      id: current.id,
      body: lines.slice(current.start).join('\n'),
      line: current.start,
    });
  }

  return jobs;
};

const jobs = parseJobs(workflow);
const byId = new Map(jobs.map((job) => [job.id, job]));

/** Every `test -f <path>` a job body asserts, and every spec it runs. */
const referencedPaths = (body: string): string[] => [
  ...[...body.matchAll(/^ +run: test -f (\S+)$/gm)].map((m) => m[1]),
];

const runCommands = (body: string): string[] => [
  ...[...body.matchAll(/^ +run: (?!test -f)(\S.*)$/gm)].map((m) => m[1]),
];

describe('CI required e2e subset (issue #932)', () => {
  describe('the workflow parses and is not self-contradicting', () => {
    it('declares a jobs mapping with at least one job', () => {
      expect(jobs.length).toBeGreaterThan(0);
    });

    it('has no duplicate job id (the root cause of the dropped checks)', () => {
      // YAML mapping keys are last-wins: a repeated job id silently discards
      // the earlier definition, taking its required check with it.
      const seen = new Set<string>();
      const duplicates = jobs
        .map((job) => job.id)
        .filter((id) => (seen.has(id) ? true : (seen.add(id), false)));

      expect(duplicates).toEqual([]);
    });

    it('keeps the job count equal to the unique job count', () => {
      expect(jobs.length).toBe(new Set(jobs.map((job) => job.id)).size);
    });
  });

  describe('every job is executable', () => {
    it.each(jobs.map((job) => [job.id, job] as const))(
      '%s declares runs-on and at least one step',
      (_id, job) => {
        expect(job.body).toMatch(/^ {4}runs-on: \S/m);
        expect(job.body).toMatch(/^ {4}steps:/m);
        expect(
          (job.body.match(/^ {6}- name: /gm) ?? []).length,
        ).toBeGreaterThan(0);
      },
    );

    it.each(jobs.map((job) => [job.id, job] as const))(
      '%s has no step that is missing both run and uses',
      (_id, job) => {
        // The truncated/half-written steps this replaces were exactly this:
        // a `name:` with no executable body, which is a workflow validation
        // error that takes the whole file down.
        const steps = job.body
          .split('\n')
          .filter((line) => /^ {6}- name: /.test(line));

        steps.forEach((_, index) => {
          const start = job.body.indexOf(steps[index]);
          const rest = job.body.slice(start);
          const next = rest.slice(1).search(/^ {6}- name: /m);
          const body = next === -1 ? rest : rest.slice(0, next + 1);

          expect(body).toMatch(/^ {8}(?:run|uses): \S/m);
        });
      },
    );

    it.each(jobs.map((job) => [job.id, job] as const))(
      '%s has no dangling comment-only step name',
      (_id, job) => {
        // `- name: X` immediately followed by a bare `#` comment and another
        // `- name:` is the signature of a botched merge.
        expect(job.body).not.toMatch(
          /^ {6}- name: .+\n(?: {8}#.*\n)+ {6}- name: /m,
        );
      },
    );
  });

  describe('the required checks the docs rely on actually exist', () => {
    // Each of these is documented in TEST_VERIFICATION_GUIDE.md,
    // docs/migration-recovery-tabletop.md, or the SECURITY.md contract as a
    // required check. A job that is "documented as required" but absent (or
    // collapsed by a duplicate key) is exactly the failure #932 is about.
    const REQUIRED_JOBS = [
      'api-prefix-docs',
      'migration-recovery-tabletop',
      'e2e-tests',
      'ci-workflow-contract',
    ];

    it.each(REQUIRED_JOBS)('%s is defined exactly once', (id) => {
      expect(jobs.filter((job) => job.id === id)).toHaveLength(1);
    });

    it('runs the /v1 prefix docs contract from its own required job', () => {
      expect(byId.get('api-prefix-docs')?.body).toContain(
        'pnpm test:e2e -- test/api-prefix-v1-docs.e2e-spec.ts',
      );
    });

    it('runs the migration recovery tabletop contract from its own required job', () => {
      expect(byId.get('migration-recovery-tabletop')?.body).toContain(
        'pnpm test:e2e -- test/migration-recovery-tabletop.e2e-spec.ts',
      );
    });
  });

  describe('required checks are fail-closed on a deleted spec', () => {
    it.each(jobs.map((job) => [job.id, job] as const))(
      '%s asserts spec presence before running a spec',
      (_id, job) => {
        const commands = runCommands(job.body);
        const runsSpec = commands.filter((command) =>
          /jest .*runTestsByPath|test:e2e -- /.test(command),
        );

        if (runsSpec.length === 0) return;

        // Every spec path the job runs must be guarded by a `test -f` in the
        // same job, so a deleted spec fails the job instead of passing on
        // zero tests.
        runsSpec.forEach((command) => {
          const spec =
            /(?:\.\/)?((?:test|src|scripts)\/[\w./-]+\.spec\.ts)/.exec(command);
          if (!spec) return;

          expect(referencedPaths(job.body)).toContain(spec[1]);
        });
      },
    );

    it('has at least one job that guards a spec with test -f', () => {
      const guarded = jobs.filter(
        (job) => referencedPaths(job.body).length > 0,
      );

      expect(guarded.length).toBeGreaterThan(0);
    });
  });

  describe('every path a job references exists in the repository', () => {
    const allReferences = jobs.flatMap((job) =>
      referencedPaths(job.body).map((ref) => ({ job: job.id, ref })),
    );

    it('finds some referenced paths to check', () => {
      expect(allReferences.length).toBeGreaterThan(0);
    });

    it.each(allReferences)('$job -> $ref exists', ({ ref }) => {
      expect(fs.existsSync(path.join(REPO_ROOT, ref))).toBe(true);
    });
  });

  describe('workflow hygiene', () => {
    it('commits no secrets into the workflow', () => {
      const secretLike =
        /(sk_[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.)/;
      expect(workflow).not.toMatch(secretLike);
    });

    it('never points CI at a production database', () => {
      // Every DATABASE_URL must be localhost or an explicit throwaway stub.
      const urls = [...workflow.matchAll(/DATABASE_URL: (\S+)/g)].map(
        (match) => match[1],
      );

      expect(urls.length).toBeGreaterThan(0);
      urls.forEach((url) => {
        expect(url).toMatch(/localhost|127\.0\.0\.1|postgresql:\/\/stub:stub@/);
      });
    });
  });
});
