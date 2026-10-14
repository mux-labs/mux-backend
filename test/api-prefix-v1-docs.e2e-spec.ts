import * as fs from 'fs';
import * as path from 'path';

/**
 * Contract test for the `/v1` API prefix documentation (issues #931, #930).
 *
 * README_V1_PREFIX.md and TEST_VERIFICATION_GUIDE.md are the entry points
 * contributors read before touching routing. They used to state a test count
 * that did not exist ("56+ test cases", "40+ tests"), described a suite that
 * is not in the spec ("HTTP Methods"), and listed suites whose real names had
 * drifted. Documentation that lies about coverage is worse than no
 * documentation: a contributor trusts "56 tests" and skips reading the spec.
 *
 * This test makes the two guides self-verifying. It parses the real spec file
 * and fails closed whenever the documents disagree with it, so the counts can
 * never silently rot again. It is documentation/CI only: no DB, no network, no
 * secrets.
 *
 * #932 covers the CI wiring that runs this contract test as a required check.
 */

const REPO_ROOT = path.join(__dirname, '..');

const read = (relativePath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');

const SPEC = 'test/api-prefix-v1.e2e-spec.ts';
const GUIDE = 'TEST_VERIFICATION_GUIDE.md';
const README = 'README_V1_PREFIX.md';

interface SuiteFacts {
  /** Suite title as written in the spec's `describe(...)`. */
  title: string;
  /** Number of test cases the suite actually defines. */
  cases: number;
}

interface TestCaseFacts {
  /** Number of suites defined in the spec. */
  suites: SuiteFacts[];
  /** Total number of test cases across all suites. */
  total: number;
}

/**
 * Count the test cases a suite body defines.
 *
 * `it('...')` contributes 1. `it.each(<entries>)` contributes the number of
 * entries it is parameterised over, which is how the "Prefix completeness"
 * suite covers the whole v1 path list in one declaration. `fileSource` is used
 * to resolve a parameter array declared as a `const` in the spec.
 */
const countCasesIn = (body: string, fileSource: string): number => {
  const single = (body.match(/\bit\(['"`]/g) ?? []).length;

  // Each `it.each(...)` argument is extracted with paren balancing so nested
  // calls such as `it.each(v1Paths.map((p) => p.replace('/v1', '')))` parse.
  const eachBlocks = [...body.matchAll(/\bit\.each\(/g)].reduce(
    (blocks: string[], match) => {
      let depth = 1;
      let cursor = match.index + match[0].length;
      while (cursor < body.length && depth > 0) {
        if (body[cursor] === '(') depth += 1;
        if (body[cursor] === ')') depth -= 1;
        cursor += 1;
      }
      blocks.push(body.slice(match.index + match[0].length, cursor - 1));
      return blocks;
    },
    [],
  );

  const parameterised = eachBlocks.reduce((sum, arg) => {
    const source = arg.trim();

    const literal = source.match(/^\[/);
    if (literal) {
      const entries = source.match(/'[^']*'/g) ?? [];
      return sum + (entries.length > 0 ? entries.length : 1);
    }

    // `it.each(someArray)` or a 1:1 derivation of it (`someArray.map(...)`) —
    // resolve the array literal declared as a `const` in the spec.
    const identifier = source.split('.')[0].trim();
    const declaration = new RegExp(
      `const\\s+${identifier.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`,
      'm',
    ).exec(fileSource);

    if (declaration) {
      const entries = declaration[1].match(/'[^']*'/g) ?? [];
      return sum + (entries.length > 0 ? entries.length : 1);
    }

    return sum + 1;
  }, 0);

  return single + parameterised;
};

/**
 * Extract every top-level `describe` block from the spec and count the test
 * cases it contains. Uses brace depth rather than a full parse so the test
 * stays dependency-free and tolerant of formatting.
 */
const parseSpec = (source: string): TestCaseFacts => {
  const suites: SuiteFacts[] = [];

  const describeRe = /^ {2}describe\('([^']+)', \(\) => \{$/gm;
  let match: RegExpExecArray | null;

  while ((match = describeRe.exec(source)) !== null) {
    const title = match[1];
    const bodyStart = match.index + match[0].length;

    // Walk forward to the matching closing brace of this describe block.
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < source.length && depth > 0) {
      const char = source[cursor];
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      cursor += 1;
    }

    suites.push({
      title,
      cases: countCasesIn(source.slice(bodyStart, cursor), source),
    });
  }

  return {
    suites,
    total: suites.reduce((sum, suite) => sum + suite.cases, 0),
  };
};

/**
 * Read the machine-checkable suite table out of a markdown document.
 *
 * Expected shape (one row per suite, plus a bolded total row):
 *
 *   | 1 | `Global /v1 prefix verification` | 6 |
 *   |   | **Total** | **42** |
 */
const parseSuiteTable = (
  doc: string,
): { suites: SuiteFacts[]; total: number } => {
  const suites: SuiteFacts[] = [];
  const rowRe = /^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|$/gm;
  let match: RegExpExecArray | null;

  while ((match = rowRe.exec(doc)) !== null) {
    suites.push({ title: match[2], cases: Number(match[3]) });
  }

  const totalMatch = doc.match(
    /^\|\s*\|\s*\*\*Total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|$/m,
  );

  return { suites, total: totalMatch ? Number(totalMatch[1]) : NaN };
};

/**
 * Every `pnpm <script>` invocation in the documents must be a real script.
 *
 * Only lines inside a fenced code block or a command list are considered, so
 * prose such as "Node.js and npm/pnpm are installed" is not mistaken for a
 * command. `pnpm install` is a built-in command, not a package.json script.
 */
const PNPM_COMMAND_RE =
  /^\s*(?:[#>-]\s*)?(?:\$\s*)?pnpm\s+(?:run\s+)?([a-z0-9:_-]+)/gm;

describe('/v1 prefix documentation contract (issues #931, #930)', () => {
  let specSource: string;
  let guide: string;
  let readme: string;
  let facts: TestCaseFacts;
  let pkg: { scripts: Record<string, string> };

  beforeAll(() => {
    specSource = read(SPEC);
    guide = read(GUIDE);
    readme = read(README);
    facts = parseSpec(specSource);
    pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
  });

  describe('the spec the documents describe', () => {
    it('parses into at least one suite (guards the parser itself)', () => {
      expect(facts.suites.length).toBeGreaterThan(0);
      expect(facts.total).toBeGreaterThan(0);
    });

    it('covers the routing invariants the /v1 prefix guarantees', () => {
      const titles = facts.suites.map((suite) => suite.title);
      expect(titles).toEqual(
        expect.arrayContaining([
          'Global /v1 prefix verification',
          'Controller routes with /v1 prefix',
          'Error handling with /v1 prefix',
          'Public endpoint accessibility with /v1 prefix',
          'Request/response headers with /v1 prefix',
          'Prefix completeness across v1 surface',
        ]),
      );
    });
  });

  describe(`${README} accuracy (#931)`, () => {
    it('does not claim a test count that does not exist', () => {
      // "56+ test cases" and "40+ comprehensive tests" were both fiction; the
      // real spec is far smaller than advertised.
      expect(readme).not.toMatch(/56\+/);
      expect(readme).not.toMatch(/\b40\+ comprehensive/i);
    });

    it('states the real number of test cases', () => {
      expect(readme).toContain(`**${facts.total} test cases**`);
    });

    it('does not claim a suite that is not in the spec', () => {
      // Both docs described a "Test Suite 6: HTTP Methods" covering
      // GET/POST handling. No such suite exists — the method matrix lives in
      // test/error-handling.e2e-spec.ts. Assert on suite headings only, so
      // prose explaining the correction stays allowed.
      expect(readme).not.toMatch(/^#{2,3}\s+Test Suite \d+:.+HTTP Methods/im);
    });

    it('points at the spec file that actually exists', () => {
      expect(readme).toContain(SPEC);
      expect(fs.existsSync(path.join(REPO_ROOT, SPEC))).toBe(true);
    });

    it('cross-links the canonical API versioning doc', () => {
      expect(readme).toContain('docs/API-VERSIONING.md');
    });
  });

  describe(`${GUIDE} accuracy and automation (#930, #931)`, () => {
    it('documents every suite in the spec, by name and test count', () => {
      const documented = parseSuiteTable(guide);

      expect(documented.suites.map((suite) => suite.title)).toEqual(
        facts.suites.map((suite) => suite.title),
      );
      expect(documented.suites.map((suite) => suite.cases)).toEqual(
        facts.suites.map((suite) => suite.cases),
      );
    });

    it('states the real total number of test cases', () => {
      expect(parseSuiteTable(guide).total).toBe(facts.total);
    });

    it('lists one ✓ line per documented test case', () => {
      // Keeps the human-readable per-suite listings honest: the number of
      // expected-output lines must match the number of test cases claimed.
      const { suites } = parseSuiteTable(guide);
      suites.forEach((suite, index) => {
        const heading = `### Test Suite ${index + 1}: \`${suite.title}\``;
        const start = guide.indexOf(heading);
        expect(start).toBeGreaterThan(-1);

        const nextHeading = guide.indexOf(
          '### Test Suite ',
          start + heading.length,
        );
        const body =
          nextHeading === -1
            ? guide.slice(start)
            : guide.slice(start, nextHeading);

        expect((body.match(/^✓ /gm) ?? []).length).toBe(suite.cases);
      });
    });

    it('does not advertise a suite that is not in the spec', () => {
      expect(guide).not.toMatch(/^#{2,3}\s+Test Suite \d+:.+HTTP Methods/im);
    });

    it('only invokes pnpm scripts that exist in package.json', () => {
      const builtins = new Set(['install']);
      const referenced = new Set<string>();

      for (const doc of [guide, readme]) {
        for (const match of doc.matchAll(PNPM_COMMAND_RE)) {
          const script = match[1];
          if (!builtins.has(script)) referenced.add(script);
        }
      }

      expect(referenced.size).toBeGreaterThan(0);
      const missing = [...referenced].filter(
        (script) => !(script in pkg.scripts),
      );
      expect(missing).toEqual([]);
    });

    it('documents the automated check that keeps it accurate', () => {
      expect(guide).toContain('test/api-prefix-v1-docs.e2e-spec.ts');
      expect(guide).toContain(
        'pnpm test:e2e -- test/api-prefix-v1-docs.e2e-spec.ts',
      );
    });
  });

  describe('the implementation the documents point at', () => {
    it('still applies the global /v1 prefix in main.ts', () => {
      expect(read('src/main.ts')).toMatch(/app\.setGlobalPrefix\('v1'\)/);
    });

    it('commits no secrets into the prefix documentation', () => {
      const secretLike =
        /(sk_[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.)/;
      expect(guide).not.toMatch(secretLike);
      expect(readme).not.toMatch(secretLike);
    });
  });
});
