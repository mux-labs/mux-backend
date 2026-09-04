import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  FeatureFlagGuard,
  FeatureFlag,
  FEATURE_FLAG_KEY,
} from '../common/feature-flags/feature-flag.guard';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { BalanceIndexerController } from './balance-indexer.controller';

/**
 * Verifies that BalanceIndexerController is decorated with @FeatureFlag and
 * that FeatureFlagGuard enforces the flag correctly.
 */
describe('BalanceIndexerController — feature flag guard', () => {
  it('has @FeatureFlag("BALANCE_INDEXER") metadata on the controller class', () => {
    const flag = Reflect.getMetadata(
      FEATURE_FLAG_KEY,
      BalanceIndexerController,
    );
    expect(flag).toBe('BALANCE_INDEXER');
  });

  describe('FeatureFlagGuard behaviour on balance indexer routes', () => {
    let guard: FeatureFlagGuard;
    let featureFlagService: jest.Mocked<FeatureFlagService>;
    let reflector: jest.Mocked<Reflector>;

    const makeContext = (flagName: string | undefined): ExecutionContext =>
      ({
        getHandler: jest.fn().mockReturnValue(() => {}),
        getClass: jest.fn().mockReturnValue(BalanceIndexerController),
        switchToHttp: jest.fn(),
      }) as any;

    beforeEach(() => {
      featureFlagService = { isEnabled: jest.fn() } as any;
      reflector = { getAllAndOverride: jest.fn() } as any;
      guard = new FeatureFlagGuard(featureFlagService, reflector);
    });

    it('allows access when BALANCE_INDEXER flag is enabled', () => {
      reflector.getAllAndOverride.mockReturnValue('BALANCE_INDEXER');
      featureFlagService.isEnabled.mockReturnValue(true);
      expect(guard.canActivate(makeContext('BALANCE_INDEXER'))).toBe(true);
    });

    it('throws 403 when BALANCE_INDEXER flag is disabled', () => {
      reflector.getAllAndOverride.mockReturnValue('BALANCE_INDEXER');
      featureFlagService.isEnabled.mockReturnValue(false);
      expect(() => guard.canActivate(makeContext('BALANCE_INDEXER'))).toThrow(
        HttpException,
      );
      try {
        guard.canActivate(makeContext('BALANCE_INDEXER'));
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(err.getResponse().message).toContain('Feature is not available');
      }
    });

    it('allows access when no flag metadata is present (non-flagged route)', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      expect(guard.canActivate(makeContext(undefined))).toBe(true);
      expect(featureFlagService.isEnabled).not.toHaveBeenCalled();
    });
  });
});
