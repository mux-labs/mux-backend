import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  TenantScopeGuard,
  TENANT_SCOPE_KEY,
} from './tenant-scope.guard';

function buildContext(
  overrides: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    apiKeyContext?: any;
  } = {},
  metaValue?: string,
): ExecutionContext {
  const request = {
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    apiKeyContext: overrides.apiKeyContext,
    method: 'GET',
    path: '/test',
  };

  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(metaValue),
  } as unknown as Reflector;

  const ctx = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as unknown as ExecutionContext;

  // Attach the reflector mock to the guard instance in each test
  (ctx as any).__reflectorMock = reflector;

  return ctx;
}

describe('TenantScopeGuard', () => {
  let guard: TenantScopeGuard;
  let reflector: jest.Mocked<Reflector>;

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as any;
    guard = new TenantScopeGuard(reflector);
  });

  const makeCtx = (
    params: Record<string, string> = {},
    query: Record<string, string> = {},
    apiKeyContext: any = undefined,
  ): ExecutionContext => {
    const request = {
      params,
      query,
      apiKeyContext,
      method: 'GET',
      path: '/webhooks/endpoints/project/proj-1',
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;
  };

  // ---------------------------------------------------------------------------
  // No apiKeyContext — allow through (auth not our concern)
  // ---------------------------------------------------------------------------

  it('should allow through when no apiKeyContext is on the request', () => {
    reflector.getAllAndOverride.mockReturnValue('projectId');
    const ctx = makeCtx({ projectId: 'proj-1' }, {}, undefined);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // No @TenantScoped metadata
  // ---------------------------------------------------------------------------

  it('should allow through when no TENANT_SCOPE_KEY metadata is set', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = makeCtx(
      { projectId: 'proj-1' },
      {},
      { project: { id: 'proj-1' } },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow through when metadata is "none"', () => {
    reflector.getAllAndOverride.mockReturnValue('none');
    const ctx = makeCtx(
      {},
      {},
      { project: { id: 'proj-1' } },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Matching project — allow
  // ---------------------------------------------------------------------------

  it('should allow access when route param projectId matches caller projectId', () => {
    reflector.getAllAndOverride.mockReturnValue('projectId');
    const ctx = makeCtx(
      { projectId: 'proj-abc' },
      {},
      { project: { id: 'proj-abc' } },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should allow access when query param projectId matches caller projectId', () => {
    reflector.getAllAndOverride.mockReturnValue('projectId');
    const ctx = makeCtx(
      {},
      { projectId: 'proj-abc' },
      { project: { id: 'proj-abc' } },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Mismatched project — deny
  // ---------------------------------------------------------------------------

  it('should throw ForbiddenException when projectId does not match caller projectId', () => {
    reflector.getAllAndOverride.mockReturnValue('projectId');
    const ctx = makeCtx(
      { projectId: 'proj-other' },
      {},
      { project: { id: 'proj-abc' } },
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should include a descriptive message in the ForbiddenException', () => {
    reflector.getAllAndOverride.mockReturnValue('projectId');
    const ctx = makeCtx(
      { projectId: 'proj-other' },
      {},
      { project: { id: 'proj-abc' } },
    );
    let caught: ForbiddenException | undefined;
    try {
      guard.canActivate(ctx);
    } catch (e) {
      caught = e as ForbiddenException;
    }
    expect(caught).toBeInstanceOf(ForbiddenException);
    expect(caught?.message).toContain('project scope');
  });

  // ---------------------------------------------------------------------------
  // Missing param value — allow through (let handler validate)
  // ---------------------------------------------------------------------------

  it('should allow through when the named param is absent from the request', () => {
    reflector.getAllAndOverride.mockReturnValue('projectId');
    const ctx = makeCtx(
      {}, // no projectId in params
      {}, // no projectId in query
      { project: { id: 'proj-abc' } },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Custom param name
  // ---------------------------------------------------------------------------

  it('should support custom param names other than "projectId"', () => {
    reflector.getAllAndOverride.mockReturnValue('pid');
    const ctx = makeCtx(
      { pid: 'proj-xyz' },
      {},
      { project: { id: 'proj-xyz' } },
    );
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should throw when a custom param name mismatches', () => {
    reflector.getAllAndOverride.mockReturnValue('pid');
    const ctx = makeCtx(
      { pid: 'proj-other' },
      {},
      { project: { id: 'proj-xyz' } },
    );
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
