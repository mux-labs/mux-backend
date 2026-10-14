import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';

export const FEATURE_FLAG_KEY = 'featureFlag';

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

/**
 * Guard that gates access to feature-flagged endpoints.
 *
 * Deny-by-default: if the feature flag is not explicitly
 * enabled in the environment, the request is rejected with
 * 403 Forbidden.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!flag) {
      return true;
    }

    const envKey = `FEATURE_${flag.toUpperCase()}`;
    // Deny-by-default: only the exact string "true" enables the surface.
    // Everything else — unset, "1", "yes", "TRUE " — leaves it disabled, so
    // a typo or a copy-paste can never silently promote a gated surface.
    const enabled = process.env[envKey] === 'true';
    if (!enabled) {
      throw new ForbiddenException({
        errorCode: 'FEATURE_FLAG_DISABLED',
        message: `Feature flag ${envKey} is not enabled`,
      });
    }

    return true;
  }
}
