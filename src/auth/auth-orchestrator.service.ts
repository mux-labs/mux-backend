import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AuthProvider, isValidAuthProvider } from './auth-provider.enum';

export interface AuthPayload {
  authId: string;
  authProvider: AuthProvider;
}

/**
 * Plain payload shape inspected by {@link AuthPayloadValidator}.
 */
export interface AuthPayload {
  authId?: string;
  email?: string;
  displayName?: string;
  authProvider?: AuthProvider | string | null;
  network?: string;
}

/**
 * Validates authentication payloads from identity providers.
 *
 * Fail-closed: invalid or missing claims are rejected.
 */
export class AuthPayloadValidator {
  private static readonly logger = new Logger(AuthPayloadValidator.name);

  /**
   * Fail-closed: invalid or missing claims are rejected.
   */
  static validate(payload: Partial<AuthPayload> | null | undefined): void {
    if (!payload) {
      throw new BadRequestException('Missing auth payload');
    }

    if (payload.authId === undefined || payload.authId === null) {
      throw new BadRequestException('Missing authId');
    }

    if (typeof payload.authId !== 'string') {
      throw new BadRequestException('authId must be a string');
    }

    if (payload.authId.trim() === '') {
      throw new BadRequestException('authId must not be empty');
    }

    if (payload.authProvider === undefined || payload.authProvider === null) {
      throw new BadRequestException('Missing authProvider');
    }

    if (typeof payload.authProvider !== 'string') {
      throw new BadRequestException('authProvider must be a string');
    }

    if (payload.authProvider.trim() === '') {
      throw new BadRequestException('authProvider must not be empty');
    }

    if (!isValidAuthProvider(payload.authProvider)) {
      throw new BadRequestException('Invalid authProvider');
    }
  }
}

@Injectable()
export class AuthOrchestratorService {
  private static readonly MAX_LOGGED_PROVIDER_LENGTH = 64;

  private readonly logger = new Logger(AuthOrchestratorService.name);

  validatePayload(payload: Partial<AuthPayload> | null | undefined): boolean {
    if (!payload || !payload.authId) {
      this.logger.warn('Missing authId in payload');
      return false;
    }

    try {
      AuthPayloadValidator.validate(payload);
      return true;
    } catch (error) {
      this.logger.warn('Invalid authProvider', {
        providerType: typeof payload.authProvider,
        providerPreview: this.describeProvider(payload.authProvider),
        error: (error as Error).message,
      });
      return false;
    }
  }

  /**
   * Builds a bounded, non-sensitive description of the offending provider
   * value. Never returns the raw value and never touches other payload fields.
   */
  private describeProvider(value: unknown): string {
    if (typeof value !== 'string') {
      return `<${typeof value}>`;
    }

    const truncated = value.slice(0, AuthOrchestratorService.MAX_LOGGED_PROVIDER_LENGTH);
    return value.length > AuthOrchestratorService.MAX_LOGGED_PROVIDER_LENGTH
      ? `${truncated}…`
      : truncated;
  }
}
