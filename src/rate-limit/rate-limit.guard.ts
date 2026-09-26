import { Injectable, CanActivate, ExecutionContext, TooManyRequestsException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Simple in-memory rate limit guard.
 *
 * Tracks request counts per API key and rejects requests
 * that exceed the configured rate limit.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly requestCounts = new Map<string, number>();
  private readonly WINDOW_MS = 60_000;
  private readonly MAX_REQUESTS = 100;

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers?.authorization as string | undefined;
    const key = apiKey ?? 'anonymous';

    const now = Date.now();
    const count = this.requestCounts.get(key) ?? 0;

    if (count >= this.MAX_REQUESTS) {
      throw new TooManyRequestsException({
        errorCode: 'RATE_LIMIT_EXCEEDED',
        message: 'Rate limit exceeded. Please try again later.',
      });
    }

    this.requestCounts.set(key, count + 1);

    // Clean up old entries periodically
    if (this.requestCounts.size > 10_000) {
      for (const [k, v] of this.requestCounts.entries()) {
        if (v < count - this.MAX_REQUESTS) {
          this.requestCounts.delete(k);
        }
      }
    }

    return true;
  }
}
