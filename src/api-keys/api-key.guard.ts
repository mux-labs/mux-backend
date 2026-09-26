import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService } from './api-key.service';

export const REQUIRE_API_KEY = 'requireApiKey';
export const IS_PUBLIC = 'isPublic';

/**
 * Guard that validates API keys on incoming requests.
 *
 * Deny-by-default: if no valid API key is present, the request
 * is rejected with 401 Unauthorized.
 *
 * Routes can be marked public with the @Public() decorator,
 * which skips API key validation.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization as string | undefined;

    if (!authHeader) {
      throw new UnauthorizedException('API key is required');
    }

    const apiKey = this.extractApiKey(authHeader);
    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const validation = await this.apiKeyService.validateApiKey(apiKey);
    if (!validation) {
      throw new UnauthorizedException('Invalid API key');
    }

    request.apiKey = validation;
    return true;
  }

  private extractApiKey(header: string): string | null {
    if (header.startsWith('Bearer ')) {
      return header.slice(7);
    }
    if (header.startsWith('ApiKey ')) {
      return header.slice(7);
    }
    return null;
  }
}
