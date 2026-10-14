import * as fs from 'fs';
import * as path from 'path';

/**
 * Fail-closed gate for the OpenAPI lint wiring (#948).
 *
 * The Redocly CLI only *warns* about a rule name it does not know, and it
 * happily lints with `apis:`-style configuration until the CLI itself changes
 * major version. Both failure modes are silent: a typo in `redocly.yaml`
 * disables an invariant, and a floating `@latest` changes rule semantics
 * underneath us. This script makes the wiring itself part of the contract.
 *
 * Pure checks over file contents are exported for unit testing; the CLI entry
 * point reads the repository and exits non-zero on any error.
 *
 * Usage:
 *   pnpm run openapi:check-lint-config
 */

export const REPO_ROOT = path.join(__dirname, '..');
export const REDOCLY_CONFIG_FILE = 'redocly.yaml';
export const REDOCLY_ROOT = 'openapi.json';
export const REDOCLY_CLI_SPEC = '@redocly/cli@1.34.5';
export const WORKFLOW_FILE = '.github/workflows/ci.yml';
export const LINT_SCRIPT = 'openapi:lint';
export const CONFIG_CHECK_SCRIPT = 'openapi:check-lint-config';

/**
 * Built-in Redocly rule names, taken from the pinned CLI
 * (`@redocly/openapi-core` bundled with @redocly/cli@1.34.5). A configured
 * name outside this set is a typo the CLI would only warn about.
 */
export const REDOCLY_BUILTIN_RULES: readonly string[] = [
  'array-parameter-serialization',
  'assertions',
  'boolean-parameter-prefixes',
  'channels-kebab-case',
  'component-name-unique',
  'criteria-unique',
  'info-contact',
  'info-license',
  'info-license-strict',
  'info-license-url',
  'no-ambiguous-paths',
  'no-channel-trailing-slash',
  'no-empty-servers',
  'no-enum-type-mismatch',
  'no-example-value-and-externalValue',
  'no-http-verbs-in-paths',
  'no-identical-paths',
  'no-invalid-media-type-examples',
  'no-invalid-parameter-examples',
  'no-invalid-schema-examples',
  'no-path-trailing-slash',
  'no-required-schema-properties-undefined',
  'no-schema-type-mismatch',
  'no-server-example.com',
  'no-server-trailing-slash',
  'no-server-variables-empty-enum',
  'no-undefined-server-variable',
  'no-unused-components',
  'operation-2xx-response',
  'operation-4xx-problem-details-rfc7807',
  'operation-4xx-response',
  'operation-description',
  'operation-operationId',
  'operation-operationId-unique',
  'operation-operationId-url-safe',
  'operation-parameters-unique',
  'operation-singular-tag',
  'operation-summary',
  'operation-tag-defined',
  'parameter-description',
  'parameters-unique',
  'path-declaration-must-exist',
  'path-excludes-patterns',
  'path-http-verbs-order',
  'path-not-include-query',
  'path-params-defined',
  'path-segment-plural',
  'paths-kebab-case',
  'request-mime-type',
  'requestBody-replacements-unique',
  'required-string-property-missing-min-length',
  'response-contains-header',
  'response-contains-property',
  'response-mime-type',
  'scalar-property-missing-example',
  'security-defined',
  'sourceDescription-type',
  'sourceDescriptions-name-unique',
  'sourceDescriptions-not-empty',
  'spec-components-invalid-map-name',
  'spec-strict-refs',
  'struct',
  'tag-description',
  'tags-alphabetical',
];

/**
 * Rules that must stay `error`.
 *
 * These are the fail-closed contract invariants: an undocumented operation, an
 * operation with no documented error shape, an undefined security scheme, or a
 * dangling `$ref` is a defect a client cannot work around safely. Downgrading
 * one to `warn` silently un-gates the contract, so it is treated as a build
 * failure here.
 */
export const REQUIRED_ERROR_RULES: readonly string[] = [
  'operation-summary',
  'operation-operationId',
  'operation-4xx-response',
  'security-defined',
  'spec-strict-refs',
];

/** A rule name and its configured severity. */
export interface ConfiguredRule {
  name: string;
  severity: 'error' | 'warn' | 'off';
}

/**
 * Parse the `rules:` block of `redocly.yaml`.
 *
 * Deliberately a small, strict reader rather than a YAML dependency: the file
 * is a flat map of `rule-name: severity` entries, and a hand-rolled reader
 * keeps this gate dependency-free so it cannot break because of a transitive
 * package.
 */
export function parseConfiguredRules(contents: string): ConfiguredRule[] {
  const rules: ConfiguredRule[] = [];
  let inRules = false;
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (/^rules:\s*$/.test(line)) {
      inRules = true;
      continue;
    }
    if (!inRules) {
      continue;
    }
    if (line.trim() === '') {
      continue;
    }
    // A new top-level key ends the rules block.
    if (/^\S/.test(line)) {
      break;
    }
    const match = line.match(
      /^\s+([A-Za-z0-9][A-Za-z0-9._-]*):\s*(error|warn|off)\s*$/,
    );
    if (match) {
      rules.push({
        name: match[1],
        severity: match[2] as ConfiguredRule['severity'],
      });
    } else if (!line.trim().startsWith('#')) {
      // Anything else in the block that is not a comment or a plain severity
      // entry is a nested structure we do not model: ignore rather than guess.
      continue;
    }
  }
  return rules;
}

/** Validate the contents of `redocly.yaml`. */
export function checkRedoclyConfig(contents: string): string[] {
  const errors: string[] = [];

  if (!/^apis:\s*$/m.test(contents)) {
    errors.push(
      `${REDOCLY_CONFIG_FILE} must declare an \`apis:\` block (the ${REDOCLY_CLI_SPEC} configuration contract).`,
    );
  }
  if (!new RegExp(`root:\\s*${REDOCLY_ROOT}\\b`).test(contents)) {
    errors.push(
      `${REDOCLY_CONFIG_FILE} must point apis.main.root at ${REDOCLY_ROOT}, the artifact produced by \`pnpm openapi:generate\`.`,
    );
  }

  const rules = parseConfiguredRules(contents);
  if (rules.length === 0) {
    errors.push(
      `${REDOCLY_CONFIG_FILE} declares no rules; the lint gate would pass everything.`,
    );
    return errors;
  }

  for (const rule of rules) {
    if (!REDOCLY_BUILTIN_RULES.includes(rule.name)) {
      errors.push(
        `${REDOCLY_CONFIG_FILE} configures unknown rule "${rule.name}". ` +
          'Redocly only warns about unknown rules, so this silently disables the invariant.',
      );
    }
  }
  for (const required of REQUIRED_ERROR_RULES) {
    const configured = rules.find((rule) => rule.name === required);
    if (!configured) {
      errors.push(
        `${REDOCLY_CONFIG_FILE} must configure "${required}"; it is part of the fail-closed contract.`,
      );
    } else if (configured.severity !== 'error') {
      errors.push(
        `${REDOCLY_CONFIG_FILE} sets "${required}" to "${configured.severity}"; it must stay "error".`,
      );
    }
  }
  return errors;
}

/** Validate the npm scripts that drive generation, linting, and drift. */
export function checkLintScripts(scripts: Record<string, string>): string[] {
  const errors: string[] = [];
  const lint = scripts[LINT_SCRIPT];
  if (!lint) {
    errors.push(`package.json is missing the "${LINT_SCRIPT}" script.`);
  } else {
    if (lint.includes('@latest')) {
      errors.push(
        `"${LINT_SCRIPT}" floats the Redocly CLI via @latest; pin it to ${REDOCLY_CLI_SPEC} so rule semantics cannot change under a CI run.`,
      );
    }
    if (!lint.includes(REDOCLY_CLI_SPEC)) {
      errors.push(
        `"${LINT_SCRIPT}" must run ${REDOCLY_CLI_SPEC} (the version the rule list is taken from).`,
      );
    }
    if (!lint.includes('--config') || !lint.includes(REDOCLY_CONFIG_FILE)) {
      errors.push(
        `"${LINT_SCRIPT}" must pass --config ${REDOCLY_CONFIG_FILE}; the checked-in rules would otherwise be ignored.`,
      );
    }
  }
  if (!scripts['openapi:generate']) {
    errors.push(
      'package.json is missing the "openapi:generate" script; the linted artifact would not exist.',
    );
  }
  if (!scripts[CONFIG_CHECK_SCRIPT]) {
    errors.push(
      `package.json is missing the "${CONFIG_CHECK_SCRIPT}" script that keeps this gate runnable.`,
    );
  }
  return errors;
}

/** Validate that CI actually runs both the lint and the config gate. */
export function checkWorkflow(contents: string): string[] {
  const errors: string[] = [];
  if (!contents.includes(LINT_SCRIPT)) {
    errors.push(
      `${WORKFLOW_FILE} never runs "${LINT_SCRIPT}"; the OpenAPI lint would be ungated.`,
    );
  }
  if (!contents.includes(CONFIG_CHECK_SCRIPT)) {
    errors.push(
      `${WORKFLOW_FILE} never runs "${CONFIG_CHECK_SCRIPT}"; a broken lint config would be ungated.`,
    );
  }
  if (!contents.includes('openapi:check-drift')) {
    errors.push(
      `${WORKFLOW_FILE} never runs "openapi:check-drift"; the committed spec could drift silently.`,
    );
  }
  return errors;
}

/** Validate every input at once; returns the list of failures. */
export function checkOpenapiLintContract(files: {
  redocly: string;
  packageJson: string;
  workflow: string;
}): string[] {
  const errors = [
    ...checkRedoclyConfig(files.redocly),
    ...checkWorkflow(files.workflow),
  ];
  let scripts: Record<string, string> = {};
  try {
    scripts =
      (JSON.parse(files.packageJson) as { scripts?: Record<string, string> })
        .scripts ?? {};
  } catch {
    errors.push('package.json is not valid JSON.');
    return errors;
  }
  return [...errors, ...checkLintScripts(scripts)];
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

function main(): void {
  const errors = checkOpenapiLintContract({
    redocly: readRepoFile(REDOCLY_CONFIG_FILE),
    packageJson: readRepoFile('package.json'),
    workflow: readRepoFile(WORKFLOW_FILE),
  });

  if (errors.length > 0) {
    console.error(
      '[openapi:check-lint-config] ERROR: OpenAPI lint contract violated:',
    );
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  console.log(
    '[openapi:check-lint-config] OK — Redocly config, npm scripts, and CI wiring agree.',
  );
}

if (require.main === module) {
  main();
}
