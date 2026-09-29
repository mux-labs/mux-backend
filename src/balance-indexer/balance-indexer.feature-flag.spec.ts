import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  FeatureFlagGuard,
  FeatureFlag,
  FEATURE_FLAG_KEY,
} from '../common/feature-flags/feature-flag.guard';
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
    let reflector: jest.Mocked<Reflector>;

    const makeContext = (flagName: string | undefined): ExecutionContext =>
      ({
        getHandler: jest.fn().mockReturnValue(() => {}),
        getClass: jest.fn().mockReturnValue(BalanceIndexerController),
        switchToHttp: jest.fn(),
      }) as any;

    beforeEach(() => {
      // The guard resolves flags straight from the environment
      // (FEATURE_<FLAG>), so the env — not a service — is the seam under test.
      delete process.env.FEATURE_BALANCE_INDEXER;
      reflector = { getAllAndOverride: jest.fn() } as any;
      guard = new FeatureFlagGuard(reflector);
    });

    it('allows access when BALANCE_INDEXER flag is enabled', () => {
      process.env.FEATURE_BALANCE_INDEXER = 'true';
      reflector.getAllAndOverride.mockReturnValue('BALANCE_INDEXER');
      expect(guard.canActivate(makeContext('BALANCE_INDEXER'))).toBe(true);
    });

    it('throws 403 when BALANCE_INDEXER flag is disabled', () => {
      process.env.FEATURE_BALANCE_INDEXER = 'false';
      reflector.getAllAndOverride.mockReturnValue('BALANCE_INDEXER');
      expect(() => guard.canActivate(makeContext('BALANCE_INDEXER'))).toThrow(
        HttpException,
      );
      try {
        guard.canActivate(makeContext('BALANCE_INDEXER'));
      } catch (err: any) {
        expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
        expect(err.getResponse().message).toContain('not enabled');
      }
    });

    it('fails closed when the flag is unset', () => {
      reflector.getAllAndOverride.mockReturnValue('BALANCE_INDEXER');
      expect(() => guard.canActivate(makeContext('BALANCE_INDEXER'))).toThrow(
        HttpException,
      );
    });

    it('allows access when no flag metadata is present (non-flagged route)', () => {
      reflector.getAllAndOverride.mockReturnValue(undefined);
      expect(guard.canActivate(makeContext(undefined))).toBe(true);
    });

    afterEach(() => {
      delete process.env.FEATURE_BALANCE_INDEXER;
    });
  });
});
