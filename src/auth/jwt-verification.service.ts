import {
  Injectable,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * Service for verifying JWTs from configured identity providers (Clerk, Better Auth).
 *
 * CRITICAL: This service currently requires the `jsonwebtoken` library to be installed.
 * Without it, JWT verification will fail in production (fail-closed, not fail-open).
 *
 * In development/test, a stub mode is available for local development without
 * live provider credentials.
 */
@Injectable()
export class JwtVerificationService {
  private readonly logger = new Logger(JwtVerificationService.name);
  private devModeEnabled = process.env.NODE_ENV !== 'production' &&
                           process.env.AUTH_SKIP_JWT_VERIFICATION === 'true';

  /**
   * Verifies a bearer token and extracts the identity claims.
   *
   * Fails closed in production if:
   * - No token is provided
   * - Token signature is invalid
   * - Token is expired
   * - JWT verification library is not available
   *
   * @param bearerToken The raw bearer token (without 'Bearer ' prefix)
   * @param sourceRequest The Express request object (for logging context)
   * @returns Verified token payload with at minimum { sub, auth_provider }
   * @throws UnauthorizedException if verification fails
   * @throws ServiceUnavailableException if verifier is unavailable in production
   */
  async verifyToken(
    bearerToken: string,
    sourceRequest?: any,
  ): Promise<{ sub: string; auth_provider: string; [key: string]: any }> {
    if (!bearerToken || !bearerToken.trim()) {
      throw new UnauthorizedException('Bearer token is required');
    }

    // Dev/test stub path (explicitly dev-only, fails closed in production)
    if (this.devModeEnabled) {
      this.logger.warn(
        'Using dev-mode JWT verification stub (AUTH_SKIP_JWT_VERIFICATION=true). ' +
        'This must NEVER be enabled in production.',
      );
      // Parse a stub token format: "dev-<provider>-<userid>"
      if (bearerToken.startsWith('dev-')) {
        const parts = bearerToken.split('-');
        if (parts.length >= 3) {
          return {
            sub: parts.slice(2).join('-'),
            auth_provider: parts[1].toUpperCase(),
          };
        }
      }
      throw new UnauthorizedException(
        'Dev stub token must match format: dev-<provider>-<userid>',
      );
    }

    // Production path: Requires jsonwebtoken library + configured identity provider
    if (process.env.NODE_ENV === 'production') {
      // Check for JWT verification capability
      let jwt;
      try {
        // Attempt to require jsonwebtoken (will fail if not installed)
        jwt = require('jsonwebtoken');
      } catch (e) {
        this.logger.error(
          'JWT verification library not available. Install jsonwebtoken: ' +
          'npm install jsonwebtoken',
        );
        throw new ServiceUnavailableException(
          'Authentication service unavailable',
        );
      }

      // Check for configured identity provider (CLERK_JWT_PUBLIC_KEY, BETTER_AUTH_JWKS_URL, etc.)
      const identityProvider = process.env.AUTH_IDENTITY_PROVIDER;
      if (!identityProvider) {
        this.logger.error(
          'AUTH_IDENTITY_PROVIDER not configured. ' +
          'Set to CLERK or BETTER_AUTH with corresponding verification keys.',
        );
        throw new ServiceUnavailableException(
          'Authentication service unavailable',
        );
      }

      // Placeholder for actual JWT verification logic
      // This will be implemented once jsonwebtoken is added as a dependency
      throw new ServiceUnavailableException(
        'JWT verification not yet implemented. ' +
        'See src/auth/jwt-verification.service.ts',
      );
    }

    // Non-production, non-dev mode: use a test stub for consistency
    throw new UnauthorizedException(
      'Token verification requires jsonwebtoken library to be installed. ' +
      'Enable AUTH_SKIP_JWT_VERIFICATION=true for dev/test mode.',
    );
  }

  /**
   * Extracts the bearer token from an Authorization header.
   * Returns null if the header is missing or malformed.
   */
  extractBearerToken(authorizationHeader: string | undefined): string | null {
    if (!authorizationHeader) {
      return null;
    }

    const parts = authorizationHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return null;
    }

    return parts[1];
  }
}
