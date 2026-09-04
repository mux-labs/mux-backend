import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { FeatureFlagGuard, FEATURE_FLAG_KEY } from '../common/feature-flags/feature-flag.guard';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

describe('Webhooks feature flag guard', () => {
  let guard: FeatureFlagGuard;
  let featureFlagService: FeatureFlagService;
  let reflector: Reflector;

  const context = {
    getHandler: () => WebhookController.prototype.createEndpoint,
    getClass: () => WebhookController,
    switchToHttp: jest.fn(),
  } as unknown as ExecutionContext;

  beforeEach(() => {
    featureFlagService = {
      isEnabled: jest.fn(),
    } as unknown as FeatureFlagService;

    reflector = {
      getAllAndOverride: jest.fn().mockReturnValue('webhooks_enabled'),
    } as unknown as Reflector;

    guard = new FeatureFlagGuard(featureFlagService, reflector);
  });

  it('allows requests when FEATURE_WEBHOOKS_ENABLED=true', () => {
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(true);

    expect(guard.canActivate(context)).toBe(true);
    expect(featureFlagService.isEnabled).toHaveBeenCalledWith('webhooks_enabled');
  });

  it('returns 403 when FEATURE_WEBHOOKS_ENABLED=false', () => {
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(false);

    try {
      guard.canActivate(context);
      fail('Expected guard to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
      const body = (error as HttpException).getResponse() as Record<string, unknown>;
      expect(body.message).toContain('Feature is not available');
    }
  });

  it('returns 403 when FEATURE_WEBHOOKS_ENABLED is unset', () => {
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(false);

    expect(() => guard.canActivate(context)).toThrow(HttpException);
  });

  it('reads webhooks_enabled flag from controller metadata', () => {
    jest.spyOn(featureFlagService, 'isEnabled').mockReturnValue(true);

    guard.canActivate(context);

    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(FEATURE_FLAG_KEY, [
      WebhookController.prototype.createEndpoint,
      WebhookController,
    ]);
  });
});

describe('WebhookController with FeatureFlagService', () => {
  it('registers webhooks_enabled on the controller class', () => {
    const reflector = new Reflector();
    const flag = reflector.get<string>(
      FEATURE_FLAG_KEY,
      WebhookController,
    );
    expect(flag).toBe('webhooks_enabled');
  });

  it('bootstraps controller with feature flag service', async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: {} },
        { provide: WebhookDispatcherService, useValue: {} },
        {
          provide: FeatureFlagService,
          useValue: { isEnabled: jest.fn().mockReturnValue(true) },
        },
      ],
    }).compile();

    expect(module.get(WebhookController)).toBeDefined();
  });
});
