import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AuthRateLimitService } from './auth-rate-limit.service';

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(AuthRateLimitGuard.name);

  constructor(private readonly authRateLimitService: AuthRateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const ipAddress = this.extractIpAddress(request);

    this.logger.debug(
      `Checking auth rate limit for IP: ${ipAddress}`,
    );

    // Check rate limit
    const result = await this.authRateLimitService.checkRateLimit(ipAddress);

    // Set rate limit headers
    const response = context.switchToHttp().getResponse();
    response.setHeader('X-RateLimit-Limit', result.limit);
    response.setHeader('X-RateLimit-Remaining', result.remaining);
    response.setHeader(
      'X-RateLimit-Reset',
      Math.ceil(result.resetTime.getTime() / 1000),
    );

    if (!result.allowed) {
      this.logger.warn(
        `Auth rate limit exceeded for IP ${ipAddress}: ${result.limit} requests per ${this.authRateLimitService.getConfig().windowMs}ms`,
      );

      // Set Retry-After header
      if (result.retryAfterSeconds) {
        response.setHeader('Retry-After', result.retryAfterSeconds.toString());
      }

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many authentication attempts. Please try again later.',
          retryAfter: result.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Extracts client IP address from request
   * Supports X-Forwarded-For header (for proxies/load balancers)
   */
  private extractIpAddress(request: any): string {
    // Check X-Forwarded-For header first (for proxies/load balancers)
    const forwardedFor = request.headers['x-forwarded-for'];
    if (forwardedFor) {
      // X-Forwarded-For can contain multiple IPs, take the first one
      const ips = forwardedFor.split(',');
      return ips[0].trim();
    }

    // Fall back to request connection address
    return (
      request.connection.remoteAddress ||
      request.socket.remoteAddress ||
      request.connection.socket?.remoteAddress ||
      'unknown'
    );
  }
}
