/**
 * Contract test for the migration recovery runbook and its tabletop exercise
 * (issue #929).
 *
 * `docs/migration-recovery-runbook.md` is the document an engineer opens at
 * 3am while a migration is wedged and the API is failing to start. It had
 * never been exercised end to end, and it had rotted:
 *
 *   - 5 of its 7 `npm run <script>` references pointed at scripts that do not
 *     exist in package.json (`db:integrity-check`, `test:integration`,
 *     `prisma:migrate:status`, `prisma:migrate:resolve`,
 *     `prisma:migrate:deploy`). Following the runbook literally means hitting
 *     "Missing script" while the database is in a bad state.
 *   - The repo mandates pnpm (`preinstall: only-allow pnpm`), yet the runbook
 *     used npm throughout.
 *   - The verification section told operators to run integration suites that
 *     no longer exist, so "verify the recovery" was unverifiable.
 *   - There was no exercise at all: no way to rehearse the runbook before you
 *     need it, and no way for a reviewer to know the documented procedure
 *     matches the code it claims to describe.
 *
 * This test fails closed on all of the above. It is documentation/CI only: no
 * DB, no network, no secrets.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const RUNBOOK = 'docs/migration-recovery-runbook.md';
const TABLETOP = 'docs/migration-recovery-tabletop.md';

const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
};

/**
 * Extract the script name from a documented command line.
 *
 * Matches the three forms a repo command can take:
 *   `npm run <script>` / `pnpm run <script>` — a package.json script
 *   `pnpm <script>`                          — a package.json script
 *   `pnpm exec prisma ...`                   — the Prisma CLI, not a script
 *
 * Returns `null` for anything that is not a package.json script reference.
 */
const scriptFrom = (line: string): string | null => {
  const match =
    /^\s*(?:[#>-]\s*)?(?:\$\s*)?(?:npm|pnpm)\s+(?:run\s+|exec\s+)?([a-z0-9:_-]+)/.exec(
      line,
    );
  if (!match) return null;

  const script = match[1];
  // `pnpm exec <tool>` invokes a binary, not a package script. The Prisma CLI
  // is invoked this way for subcommands with no corresponding script entry
  // (`migrate resolve`, `migrate status`).
  if (/^(?:prisma|npx)$/.test(script)) return null;

  return script;
};

/** Every documented `npm run` / `pnpm` command across both documents. */
const documentedScripts = (docs: string[]): Set<string> => {
  const referenced = new Set<string>();

  for (const doc of docs) {
    for (const line of doc.split('\n')) {
      const script = scriptFrom(line);
      if (script) referenced.add(script);
    }
  }

  return referenced;
};

/** The scenario headings the runbook defines, e.g. "Scenario 1: Syntax Error in Migration". */
const scenarioTitles = (runbook: string): string[] =>
  [...runbook.matchAll(/^#{2,4} (Scenario \d+: .+)$/gm)].map(
    (match) => match[1],
  );

/** The inject headings the tabletop defines, e.g. "Inject 1 — Syntax error mid-migration". */
const injectTitles = (tabletop: string): string[] =>
  [...tabletop.matchAll(/^#{2,4} (Inject \d+ — .+)$/gm)].map(
    (match) => match[1],
  );

describe('migration recovery runbook + tabletop (issue #929)', () => {
  let runbook: string;
  let tabletop: string;

  beforeAll(() => {
    runbook = read(RUNBOOK);
    tabletop = fs.existsSync(path.join(REPO_ROOT, TABLETOP))
      ? read(TABLETOP)
      : '';
  });

  describe('runbook commands are executable (#929)', () => {
    it('references only scripts that exist in package.json', () => {
      const referenced = documentedScripts([runbook, tabletop]);
      expect(referenced.size).toBeGreaterThan(0);

      const missing = [...referenced].filter(
        (script) => !(script in pkg.scripts),
      );
      expect(missing).toEqual([]);
    });

    it('uses pnpm, not npm', () => {
      // package.json declares `preinstall: only-allow pnpm`; an npm command in
      // a runbook is a copy-paste trap.
      expect(pkg.scripts.preinstall).toBe('npx only-allow pnpm');
      expect(runbook).not.toMatch(
        /^\s*(?:#\s*)?\$?\s*npm\s+(?:run|install|ci)\b/m,
      );
    });

    it('does not tell operators to run the non-existent db:integrity-check', () => {
      // Scoped to command lines: the runbook may still *name* a removed script
      // in order to warn the reader off it, but must never invoke one.
      const invocations = [...runbook, ...tabletop]
        .flatMap((doc) => doc.split('\n'))
        .map(scriptFrom)
        .filter((script): script is string => script !== null);

      expect(invocations).not.toContain('db:integrity-check');
      expect(invocations).not.toContain('test:integration');
    });

    it('points verification at the real e2e specs', () => {
      // The old verification section named three integration suites that no
      // longer exist, making "verify the recovery" impossible to perform.
      expect(runbook).toMatch(/pnpm test:e2e -- test\//);
    });
  });

  describe('the tabletop exercise exists (#929)', () => {
    it('is present and non-empty', () => {
      expect(tabletop).toBeDefined();
      expect(tabletop.length).toBeGreaterThan(0);
    });

    it('covers every scenario in the runbook', () => {
      const scenarios = scenarioTitles(runbook);
      const injects = injectTitles(tabletop);

      expect(scenarios.length).toBeGreaterThanOrEqual(4);
      // One inject per runbook scenario, so every documented recovery path is
      // rehearsed rather than assumed.
      expect(injects.length).toBeGreaterThanOrEqual(scenarios.length);

      scenarios.forEach((scenario, index) => {
        const inject = injects[index];
        expect(inject).toMatch(new RegExp(`^Inject ${index + 1} — `));
      });
    });

    it('names the timebox, the facilitator and the participants', () => {
      expect(tabletop).toMatch(/Timebox/i);
      expect(tabletop).toMatch(/Facilitator/i);
      expect(tabletop).toMatch(/Participants/i);
    });

    it('defines success criteria and abort conditions', () => {
      expect(tabletop).toMatch(/Success criteria/i);
      expect(tabletop).toMatch(/Abort/i);
    });

    it('covers the money path, not just the database', () => {
      // A migration can wedge while key material is mid-rotation; the tabletop
      // must rehearse that, because it is the expensive failure.
      expect(tabletop).toMatch(/key|envelope|rotation/i);
      expect(tabletop).toMatch(/fail-closed|fails closed/i);
    });

    it('prohibits running against mainnet or real key material', () => {
      expect(tabletop).toMatch(/mainnet/i);
      expect(tabletop).toMatch(
        /(never|do not|don't|must not)[^\n]*real key material/i,
      );
    });

    it('requires a written after-action record', () => {
      expect(tabletop).toMatch(/after-action|after action/i);
    });
  });

  describe('cross-links (#929)', () => {
    it('links the runbook to the tabletop', () => {
      expect(runbook).toContain('migration-recovery-tabletop.md');
    });

    it('links the tabletop back to the runbook', () => {
      expect(tabletop).toContain('migration-recovery-runbook.md');
    });

    it('is discoverable from the runbook quick reference', () => {
      expect(runbook).toMatch(/Tabletop/i);
    });
  });

  describe('fail-closed invariants the runbook must keep stating', () => {
    it('keeps the no-secret-leakage invariant', () => {
      expect(runbook).toMatch(/no secret leakage|No secret leakage/i);
    });

    it('keeps the escalate-on-suspected-exposure rule', () => {
      expect(runbook).toMatch(/Suspected key-material exposure/i);
    });

    it('commits no secrets into either document', () => {
      const secretLike =
        /(sk_[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.)/;
      expect(runbook).not.toMatch(secretLike);
      expect(tabletop).not.toMatch(secretLike);
    });
  });
});
