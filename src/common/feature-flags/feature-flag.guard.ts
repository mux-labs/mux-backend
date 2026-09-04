import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagService } from './feature-flag.service';

export const FEATURE_FLAG_KEY = 'featureFlag';
export const FeatureFlag = (flagName: string) =>
  SetMetadata(FEATURE_FLAG_KEY, flagName);

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  private readonly logger = new Logger(FeatureFlagGuard.name);

  constructor(
    private readonly featureFlagService: FeatureFlagService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const flagName = this.reflector.getAllAndOverride<string>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no feature flag is specified, allow access
    if (!flagName) {
      return true;
    }

    // Check if feature flag is enabled
    const isEnabled = this.featureFlagService.isEnabled(flagName);

    if (!isEnabled) {
      this.logger.warn(`Feature flag ${flagName} is disabled, denying access`);
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          message: `Feature is not available at this time. (Flag: ${flagName})`,
        },
        HttpStatus.FORBIDDEN,
      );
    }

    return true;
  }
}
