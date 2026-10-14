import * as fs from 'fs';
import * as path from 'path';
import {
  REDOCLY_BUILTIN_RULES,
  REDOCLY_CLI_SPEC,
  REDOCLY_CONFIG_FILE,
  REQUIRED_ERROR_RULES,
  WORKFLOW_FILE,
  checkLintScripts,
  checkOpenapiLintContract,
  checkRedoclyConfig,
  checkWorkflow,
  parseConfiguredRules,
} from './check-openapi-lint';

const REPO_ROOT = path.join(__dirname, '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/**
 * The configuration as it looked before #948: two rule names Redocly does not
 * know (`no-empty-enum-description`, `info-description`) and a comment that
 * describes a different rule than the one configured. Kept here as the
 * regression fixture — the CLI only warns about these, so nothing else in the
 * pipeline would notice.
 */
const PRE_948_CONFIG = `# Redocly OpenAPI linting configuration
apis:
  main:
    root: openapi.json

rules:
  # Enforce all operations have summaries
  operation-summary: error
  # Ensure every path has at least one tag
  operation-operationId: warn
  # No empty descriptions
  no-empty-enum-description: warn
  # Require info.description
  info-description: warn
`;

describe('check-openapi-lint', () => {
  describe('parseConfiguredRules', () => {
    it('reads rule names and severities, ignoring comments', () => {
      const rules = parseConfiguredRules(
        [
          'rules:',
          '  # a comment',
          '  operation-summary: error',
          '  tag-description: warn',
          'other: value',
        ].join('\n'),
      );

      expect(rules).toEqual([
        { name: 'operation-summary', severity: 'error' },
        { name: 'tag-description', severity: 'warn' },
      ]);
    });
  });

  describe('checkRedoclyConfig', () => {
    it('accepts the checked-in configuration', () => {
      expect(checkRedoclyConfig(read(REDOCLY_CONFIG_FILE))).toEqual([]);
    });

    it('rejects the pre-#948 configuration (unknown rule names)', () => {
      const errors = checkRedoclyConfig(PRE_948_CONFIG);
      const joined = errors.join('\n');

      // The two typo'd rule names Redocly only warns about...
      expect(joined).toContain('no-empty-enum-description');
      expect(joined).toContain('info-description');
      // ...plus the contract invariants the old config never set to `error`.
      expect(joined).toContain('must stay "error"');
      expect(joined).toContain('operation-4xx-response');
    });

    it('rejects a contract invariant downgraded to warn', () => {
      const errors = checkRedoclyConfig(
        [
          'apis:',
          '  main:',
          '    root: openapi.json',
          'rules:',
          ...REQUIRED_ERROR_RULES.map((rule) => `  ${rule}: warn`),
        ].join('\n'),
      );

      expect(errors).toHaveLength(REQUIRED_ERROR_RULES.length);
      expect(errors.join('\n')).toContain('must stay "error"');
    });

    it('rejects a missing contract invariant', () => {
      const errors = checkRedoclyConfig(
        [
          'apis:',
          '  main:',
          '    root: openapi.json',
          'rules:',
          '  operation-summary: error',
        ].join('\n'),
      );

      expect(errors.join('\n')).toContain('operation-4xx-response');
    });

    it('rejects a config with no rules at all', () => {
      const errors = checkRedoclyConfig(
        ['apis:', '  main:', '    root: openapi.json'].join('\n'),
      );

      expect(errors.join('\n')).toContain('declares no rules');
    });

    it('rejects a config that points at the wrong artifact', () => {
      const errors = checkRedoclyConfig(
        [
          'apis:',
          '  main:',
          '    root: other.json',
          'rules:',
          '  operation-summary: error',
        ].join('\n'),
      );

      expect(errors.join('\n')).toContain('openapi.json');
    });

    it('keeps the allowlist in sync with a real Redocly rule', () => {
      expect(REDOCLY_BUILTIN_RULES).toContain('operation-summary');
      expect(REDOCLY_BUILTIN_RULES).toContain('security-defined');
      expect(REDOCLY_BUILTIN_RULES).not.toContain('no-empty-enum-description');
      expect(REDOCLY_BUILTIN_RULES).not.toContain('info-description');
    });
  });

  describe('checkLintScripts', () => {
    it('accepts the checked-in package.json', () => {
      const scripts = (
        JSON.parse(read('package.json')) as { scripts: Record<string, string> }
      ).scripts;

      expect(checkLintScripts(scripts)).toEqual([]);
      expect(scripts['openapi:lint']).toContain(REDOCLY_CLI_SPEC);
    });

    it('rejects a floating @latest CLI', () => {
      const errors = checkLintScripts({
        'openapi:generate': 'x',
        'openapi:lint':
          'npx @redocly/cli@latest lint openapi.json --config redocly.yaml',
        'openapi:check-lint-config': 'y',
      });

      expect(errors.join('\n')).toContain('@latest');
    });

    it('rejects a lint script that ignores the checked-in config', () => {
      const errors = checkLintScripts({
        'openapi:generate': 'x',
        'openapi:lint': `npx ${REDOCLY_CLI_SPEC} lint openapi.json`,
        'openapi:check-lint-config': 'y',
      });

      expect(errors.join('\n')).toContain('--config');
    });

    it('rejects missing scripts', () => {
      expect(checkLintScripts({}).join('\n')).toContain('openapi:lint');
    });
  });

  describe('checkWorkflow', () => {
    it('accepts the checked-in workflow', () => {
      expect(checkWorkflow(read(WORKFLOW_FILE))).toEqual([]);
    });

    it('rejects a workflow that never runs the lint', () => {
      const errors = checkWorkflow('name: CI\non: push\n');

      expect(errors.join('\n')).toContain('openapi:lint');
      expect(errors.join('\n')).toContain('openapi:check-lint-config');
      expect(errors.join('\n')).toContain('openapi:check-drift');
    });
  });

  it('checks every input at once', () => {
    expect(
      checkOpenapiLintContract({
        redocly: read(REDOCLY_CONFIG_FILE),
        packageJson: read('package.json'),
        workflow: read(WORKFLOW_FILE),
      }),
    ).toEqual([]);
  });

  it('reports invalid package.json without throwing', () => {
    const errors = checkOpenapiLintContract({
      redocly: read(REDOCLY_CONFIG_FILE),
      packageJson: '{ not json',
      workflow: read(WORKFLOW_FILE),
    });

    expect(errors.join('\n')).toContain('not valid JSON');
  });
});
