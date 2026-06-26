import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { FeatureFlagService } from '../common/services/feature-flag.service';

export const FEATURE_WEBHOOKS_ENABLED = 'FEATURE_WEBHOOKS_ENABLED';

@Injectable()
export class WebhooksFeatureFlagGuard implements CanActivate {
  constructor(private readonly featureFlagService: FeatureFlagService) {}

  canActivate(_context: ExecutionContext): boolean {
    if (!this.featureFlagService.isEnabled(FEATURE_WEBHOOKS_ENABLED, false)) {
      throw new ForbiddenException({
        error: 'Webhooks feature is currently disabled',
      });
    }
    return true;
  }
}
