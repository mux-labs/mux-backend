import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { randomUUID } from 'crypto';

export const FEATURE_FLAG_KEY = 'featureFlag';

/**
 * Stable, typed error codes for feature-flag denials.
 *
 * Clients branch on these codes, never on messages. Add new codes; never
 * repurpose an existing one.
 */
export const FeatureFlagErrorCode = {
  /** The flag is not explicitly enabled (the default for every money path). */
  DISABLED: 'FEATURE_FLAG_DISABLED',

  /** The global kill-switch is engaged; every gated surface is off. */
  KILL_SWITCH_ENGAGED: 'FEATURE_FLAG_KILL_SWITCH_ENGAGED',
} as const;

export type FeatureFlagErrorCode =
  (typeof FeatureFlagErrorCode)[keyof typeof FeatureFlagErrorCode];

/**
 * Global kill-switch (#944).
 *
 * When truthy, every `@FeatureFlag()`-gated surface is refused regardless of
 * its own flag. This is the operator's single lever to take all money-path
 * orchestrator surfaces offline during an incident without touching the
 * individual flags.
 */
export const FEATURE_FLAGS_KILL_SWITCH_ENV = 'FEATURE_FLAGS_KILL_SWITCH';

/**
 * Stable prefix for the human-readable denial message.
 *
 * Operator runbooks and the wallet/auth e2e suites match on it
 * (`/Feature is not available/i`), so it must not be reworded.
 */
export const FEATURE_FLAG_DISABLED_MESSAGE = 'Feature is not available';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Resolution reason for a flag decision — ops-safe, low cardinality. */
export type FeatureFlagReason =
  'enabled' | 'unset' | 'disabled' | 'kill_switch' | 'non_boolean_value';

/** Ops-safe snapshot of a flag decision. Contains no secrets. */
export interface FeatureFlagDecision {
  /** Env var the flag resolves to, e.g. `FEATURE_WALLET_ORCHESTRATOR`. */
  envKey: string;
  /** Whether the surface is enabled. */
  enabled: boolean;
  /** Why the flag resolved the way it did. */
  reason: FeatureFlagReason;
  /** Stable error code to surface when `enabled` is false. */
  denialCode: FeatureFlagErrorCode;
}

/**
 * Resolves a flag from the environment, fail-closed.
 *
 * Invariants (#944):
 * 1. **Deny-by-default.** Only the literal `"true"` (case-insensitive,
 *    trimmed) enables a surface. Unset, `"false"`, `"1"`, `"yes"`, `"TRUE "`
 *    are all disabled — a typo can never silently promote a gated surface.
 * 2. **Default-safe in production.** Resolution is identical in every
 *    environment: production does not get a more permissive parser, so a fresh
 *    production deploy starts with every gated surface *off* until an operator
 *    explicitly enables it.
 * 3. **Kill-switch wins.** A truthy `FEATURE_FLAGS_KILL_SWITCH` disables every
 *    gated surface, even ones explicitly enabled.
 * 4. A truthy-but-not-`"true"` value (`"1"`, `"on"`, ...) is reported as
 *    `non_boolean_value` so ops can see the misuse, but is still disabled.
 */
export function resolveFeatureFlag(
  flag: string,
  env: NodeJS.ProcessEnv = process.env,
): FeatureFlagDecision {
  const envKey = `FEATURE_${flag.toUpperCase()}`;

  if (
    TRUTHY.has((env[FEATURE_FLAGS_KILL_SWITCH_ENV] ?? '').trim().toLowerCase())
  ) {
    return {
      envKey,
      enabled: false,
      reason: 'kill_switch',
      denialCode: FeatureFlagErrorCode.KILL_SWITCH_ENGAGED,
    };
  }

  const raw = env[envKey];

  if (raw === undefined || raw === null || raw === '') {
    return {
      envKey,
      enabled: false,
      reason: 'unset',
      denialCode: FeatureFlagErrorCode.DISABLED,
    };
  }

  const normalized = String(raw).trim().toLowerCase();

  if (normalized === 'true') {
    return {
      envKey,
      enabled: true,
      reason: 'enabled',
      denialCode: FeatureFlagErrorCode.DISABLED,
    };
  }

  if (TRUTHY.has(normalized)) {
    return {
      envKey,
      enabled: false,
      reason: 'non_boolean_value',
      denialCode: FeatureFlagErrorCode.DISABLED,
    };
  }

  return {
    envKey,
    enabled: false,
    reason: 'disabled',
    denialCode: FeatureFlagErrorCode.DISABLED,
  };
}

/**
 * Marks a route (or controller) as gated behind a feature flag.
 *
 * The flag name is resolved against the environment as
 * `FEATURE_<UPPER_SNAKE_FLAG>`, so `@FeatureFlag('wallet_orchestrator')` reads
 * `FEATURE_WALLET_ORCHESTRATOR`. Combined with `FeatureFlagGuard` this makes
 * the surface deny-by-default: anything other than the literal string
 * `"true"` leaves the route disabled.
 */
export const FeatureFlag = (flag: string): MethodDecorator & ClassDecorator =>
  SetMetadata(FEATURE_FLAG_KEY, flag);

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  private readonly logger = new Logger(FeatureFlagGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!flag) {
      return true;
    }

    const decision = resolveFeatureFlag(flag);

    if (decision.enabled) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const correlationId =
      (request?.headers?.['x-request-id'] as string | undefined) ??
      (request?.id as string | undefined) ??
      randomUUID();

    // Ops-safe: flag name, decision, reason and correlation id only. Never the
    // credential, the request body, or any key material.
    this.logger.warn(
      `feature-flag denied env=${decision.envKey} reason=${decision.reason} ` +
        `correlationId=${correlationId}`,
    );

    throw new ForbiddenException({
      code: decision.denialCode,
      message: `${FEATURE_FLAG_DISABLED_MESSAGE}: ${decision.envKey} is not enabled`,
      correlationId,
    });
  }
}
