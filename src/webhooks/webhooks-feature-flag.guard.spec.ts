import { ForbiddenException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common/interfaces';
import { FeatureFlagService } from '../common/services/feature-flag.service';
import {
  FEATURE_WEBHOOKS_ENABLED,
  WebhooksFeatureFlagGuard,
} from './webhooks-feature-flag.guard';

describe('WebhooksFeatureFlagGuard', () => {
  let guard: WebhooksFeatureFlagGuard;
  let featureFlagService: jest.Mocked<FeatureFlagService>;
  const mockContext = {} as ExecutionContext;

  beforeEach(() => {
    featureFlagService = {
      isEnabled: jest.fn(),
    } as unknown as jest.Mocked<FeatureFlagService>;
    guard = new WebhooksFeatureFlagGuard(featureFlagService);
  });

  it('allows requests when FEATURE_WEBHOOKS_ENABLED=true', () => {
    featureFlagService.isEnabled.mockReturnValue(true);

    expect(guard.canActivate(mockContext)).toBe(true);
    expect(featureFlagService.isEnabled).toHaveBeenCalledWith(
      FEATURE_WEBHOOKS_ENABLED,
      false,
    );
  });

  it('returns 403 when FEATURE_WEBHOOKS_ENABLED=false', () => {
    featureFlagService.isEnabled.mockReturnValue(false);

    expect(() => guard.canActivate(mockContext)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(mockContext)).toThrow(
      expect.objectContaining({
        response: { error: 'Webhooks feature is currently disabled' },
      }),
    );
  });

  it('returns 403 when FEATURE_WEBHOOKS_ENABLED is unset', () => {
    featureFlagService.isEnabled.mockImplementation(
      (_flag, defaultValue) => defaultValue,
    );

    expect(() => guard.canActivate(mockContext)).toThrow(ForbiddenException);
  });
});
