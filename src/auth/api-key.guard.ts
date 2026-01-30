import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyService, ApiKeyInfo } from './api-key.service';
import { IS_PUBLIC } from './public.decorator';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const apiKey = this.extractApiKey(request);

    if (!apiKey) {
      this.logger.warn('API key missing from request');
      throw new UnauthorizedException('API key is required');
    }

    const keyInfo = await this.apiKeyService.validateApiKey(apiKey);

    if (!keyInfo) {
      this.logger.warn(
        `Invalid or inactive API key attempted: ${apiKey.substring(0, 10)}...`,
      );
      throw new UnauthorizedException('Invalid or inactive API key');
    }

    // Attach API key info to request for use in rate limiting
    request.apiKeyInfo = keyInfo;

    return true;
  }

  /**
   * Extracts API key from request headers
   * Supports both 'x-api-key' and 'Authorization: Bearer <key>' formats
   */
  private extractApiKey(request: any): string | null {
    // Check x-api-key header first
    const headerKey = request.headers['x-api-key'];
    if (headerKey) {
      return headerKey;
    }

    // Check Authorization header
    const authHeader = request.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }

    return null;
  }
}

// Extend Express Request type to include apiKeyInfo
declare global {
  namespace Express {
    interface Request {
      apiKeyInfo?: ApiKeyInfo;
    }
  }
}
