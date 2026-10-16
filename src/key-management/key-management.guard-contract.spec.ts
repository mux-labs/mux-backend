import { Test } from '@nestjs/testing';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { KeyManagementController } from './key-management.controller';
import { KeyManagementService } from './key-management.service';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

/**
 * Guard contract test for the internal key-management routes.
 *
 * The module documentation states that every route under
 * /internal/key-management/* is internal-only and must be protected by
 * authentication/authorization guards. This spec enforces that documented
 * deny-by-default contract: a newly added handler without a guard (and
 * without an explicit public opt-out marker) will fail CI.
 *
 * Accepted guard set (the guards available in this codebase):
 *   - ApiKeyGuard          (src/api-keys/api-key.guard.ts)
 *   - FeatureFlagGuard     (src/common/feature-flags/feature-flag.guard.ts)
 *
 * A handler may only be intentionally public when it carries the explicit
 * opt-out marker `@Public()` (see PUBLIC_MARKER below); an absent guard is
 * never treated as public.
 */

/**
 * Explicit opt-out marker for intentionally public handlers. A handler is
 * only allowed to be unguarded when it is decorated with this marker.
 */
const PUBLIC_MARKER = 'PUBLIC';

/**
 * The accepted authentication/authorization guard set. Any guard applied to
 * a key-management route must be one of these symbols.
 */
const ACCEPTED_GUARDS: ReadonlyArray<Function> = [ApiKeyGuard, FeatureFlagGuard];

/**
 * Reads the guard metadata Nest uses to resolve guards for a given target
 * (controller class or handler method).
 */
function getGuards(target: Function | object): Function[] {
  const guards = Reflect.getMetadata(GUARDS_METADATA, target);
  return Array.isArray(guards) ? guards : [];
}

/**
 * Returns true when the target carries the explicit public opt-out marker.
 */
function isExplicitlyPublic(target: Function | object): boolean {
  return Reflect.getMetadata(PUBLIC_MARKER, target) === true;
}

/**
 * Enumerates the route handlers registered on the controller prototype.
 */
function getRouteHandlers(controller: Function): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => {
    if (name === 'constructor') {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      controller.prototype,
      name,
    );
    return typeof descriptor?.value === 'function';
  });
}

describe('KeyManagementController guard contract', () => {
  let controller: KeyManagementController;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KeyManagementController],
      providers: [
        { provide: KeyManagementService, useValue: {} },
        { provide: KeyRotationAuditService, useValue: {} },
      ],
    }).compile();

    controller = moduleRef.get(KeyManagementController);
  });

  it('boots the controller through a Nest testing module', () => {
    expect(controller).toBeInstanceOf(KeyManagementController);
  });

  it('registers at least one route handler', () => {
    expect(getRouteHandlers(KeyManagementController).length).toBeGreaterThan(0);
  });

  it('documents the accepted guard set', () => {
    expect(ACCEPTED_GUARDS).toEqual([ApiKeyGuard, FeatureFlagGuard]);
  });

  it('applies an accepted guard to every handler (deny-by-default)', () => {
    const controllerGuards = getGuards(KeyManagementController);
    const handlers = getRouteHandlers(KeyManagementController);

    const unguarded: string[] = [];

    for (const handler of handlers) {
      const handlerFn = (KeyManagementController.prototype as Record<
        string,
        unknown
      >)[handler] as Function;

      const guards = [...controllerGuards, ...getGuards(handlerFn)];
      const hasAcceptedGuard = guards.some((guard) =>
        ACCEPTED_GUARDS.includes(guard),
      );

      if (!hasAcceptedGuard && !isExplicitlyPublic(handlerFn)) {
        unguarded.push(handler);
      }
    }

    expect(unguarded).toEqual([]);
  });
});
