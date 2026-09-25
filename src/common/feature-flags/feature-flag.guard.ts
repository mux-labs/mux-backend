import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const FEATURE_FLAG_KEY = 'featureFlag';

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

    const enabled = process.env[`FEATURE_${flag}`] === 'true';
    if (!enabled) {
      throw new ForbiddenException({
        errorCode: 'FEATURE_FLAG_DISABLED',
        message: `Feature flag ${flag} is not enabled`,
      });
    }

    return true;
  }
}
