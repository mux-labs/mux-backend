import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FeatureFlagGuard, FEATURE_FLAG_KEY } from './feature-flag.guard';
import { FeatureFlagService } from './feature-flag.service';

describe('FeatureFlagGuard', () => {
  let guard: FeatureFlagGuard;
  let featureFlagService: FeatureFlagService;
  let reflector: Reflector;
  let context: ExecutionContext;

  beforeEach(() => {
    featureFlagService = {
      isEnabled: jest.fn(),
    } as any;

    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;

    guard = new FeatureFlagGuard(featureFlagService, reflector);

    context = {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: jest.fn(),
    } as any;
  });

  it('should allow access when no feature flag is specified', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(featureFlagService.isEnabled).not.toHaveBeenCalled();
  });

  it('should allow access when feature flag is enabled', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('transactions_api');
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(true);

    const result = guard.canActivate(context);

    expect(result).toBe(true);
    expect(featureFlagService.isEnabled).toHaveBeenCalledWith('transactions_api');
  });

  it('should deny access when feature flag is disabled', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('transactions_api');
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(false);

    expect(() => guard.canActivate(context)).toThrow(HttpException);
  });

  it('should return 403 status when feature flag is disabled', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('transactions_api');
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(false);

    try {
      guard.canActivate(context);
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
      const response = error.getResponse() as any;
      expect(response.statusCode).toBe(HttpStatus.FORBIDDEN);
      expect(response.message).toContain('Feature is not available');
    }
  });

  it('should check getAllAndOverride with correct arguments', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('transactions_api');
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(true);
    const handler = () => {};
    const klass = class {};
    context.getHandler = () => handler;
    context.getClass = () => klass;

    guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(FEATURE_FLAG_KEY, [
      handler,
      klass,
    ]);
  });
});
