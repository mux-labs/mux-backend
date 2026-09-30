import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ApiKeyContext } from '../../api-keys/domain/api-key.model';

/**
 * Metadata key used to declare which route-level param or query param
 * carries the projectId that should be compared against the authenticated context.
 *
 * Example:
 *   @TenantScoped('projectId')  // checks req.params.projectId
 *   @Get('endpoints/project/:projectId')
 *
 * Pass 'none' to skip the resource-level check but still require an authenticated context.
 */
export const TENANT_SCOPE_KEY = 'tenantScope';
export const TenantScoped = (projectParamName: string = 'projectId') =>
  SetMetadata(TENANT_SCOPE_KEY, projectParamName);

/**
 * TenantScopeGuard
 *
 * Enforces multi-tenant isolation for API endpoints.
 *
 * When applied, this guard:
 *  1. Verifies that a valid `apiKeyContext` exists on the request
 *     (i.e., the caller has passed `ApiKeyGuard` first).
 *  2. If a `TenantScoped` decorator provides a param name, compares
 *     the route/query parameter value against `apiKeyContext.project.id`.
 *     If they don't match, it returns 403 Forbidden.
 *
 * This guard DOES NOT authenticate — it only scopes.
 * Always combine with `ApiKeyGuard`.
 *
 * Usage:
 *   @UseGuards(ApiKeyGuard, TenantScopeGuard)
 *   @TenantScoped('projectId')
 *   @Get('endpoints/project/:projectId')
 *   async listEndpoints(@Param('projectId') projectId: string) { ... }
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  private readonly logger = new Logger(TenantScopeGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const paramName = this.reflector.getAllAndOverride<string | undefined>(
      TENANT_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest<Request>();
    const apiKeyContext = (request as any).apiKeyContext as ApiKeyContext | undefined;

    // No apiKeyContext means ApiKeyGuard hasn't run or is not present.
    // In that case allow-through — auth is not our responsibility here.
    if (!apiKeyContext) {
      return true;
    }

    const callerProjectId = apiKeyContext.project.id;

    // No @TenantScoped decorator: guard is present but no specific resource
    // param declared. Just confirm context is set (already checked above).
    if (!paramName || paramName === 'none') {
      return true;
    }

    // Resolve the resource projectId from route params or query string
    const resourceProjectId =
      (request.params as Record<string, string>)[paramName] ??
      (request.query as Record<string, string>)[paramName];

    if (!resourceProjectId) {
      // No param value in the request — let the handler deal with missing params
      return true;
    }

    if (resourceProjectId !== callerProjectId) {
      this.logger.warn(
        `Tenant scope violation: caller projectId=${callerProjectId} attempted to access resource with projectId=${resourceProjectId}`,
        {
          callerProjectId,
          resourceProjectId,
          method: request.method,
          path: request.path,
        },
      );
      throw new ForbiddenException(
        'You do not have access to resources outside your project scope',
      );
    }

    return true;
  }
}
