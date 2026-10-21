import * as path from 'path';

// Guard spec: ensures the effective Jest configuration actually collects the
// scripts specs. If the root config stops matching scripts/**/*.spec.ts (or a
// conflicting scripts/jest.config.js reappears), this test fails.

describe('Jest configuration', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const pkg = require(path.join(repoRoot, 'package.json'));
  const jestConfig = pkg.jest;

  const scriptsSpecs = [
    'scripts/check-migration-naming.spec.ts',
    'scripts/verify-key-management-consolidation.spec.ts',
  ];

  it('defines a root Jest config in package.json', () => {
    expect(jestConfig).toBeDefined();
    expect(jestConfig.testRegex || jestConfig.testMatch).toBeDefined();
  });

  it('does not leave a conflicting scripts/jest.config.js', () => {
    const fs = require('fs');
    expect(fs.existsSync(path.join(repoRoot, 'scripts', 'jest.config.js'))).toBe(
      false,
    );
  });

  it('scopes rootDir to the repo root and includes the scripts directory', () => {
    expect(jestConfig.rootDir).toBe('.');
    expect(jestConfig.roots).toEqual(
      expect.arrayContaining(['<rootDir>/src', '<rootDir>/scripts']),
    );
  });

  it.each(scriptsSpecs)(
    'matches scripts spec %s via testRegex/testMatch',
    (specPath) => {
      const patterns: string[] = [];
      if (jestConfig.testRegex) {
        patterns.push(jestConfig.testRegex);
      }
      if (Array.isArray(jestConfig.testMatch)) {
        patterns.push(...jestConfig.testMatch);
      }

      const matched = patterns.some((pattern) =>
        new RegExp(pattern).test(specPath),
      );

      expect(matched).toBe(true);
    },
  );
});
