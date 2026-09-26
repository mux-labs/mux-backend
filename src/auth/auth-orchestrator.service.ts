import { Injectable, Logger } from '@nestjs/common';
import { AuthProvider } from './auth-provider.enum';

export interface AuthPayloadValidator {
  authId: string;
  email?: string;
  displayName?: string;
  authProvider: AuthProvider;
  network: string;
}

/**
 * Validates authentication payloads from identity providers.
 *
 * Fail-closed: invalid or missing claims are rejected.
 */
@Injectable()
export class AuthOrchestratorService {
  private readonly logger = new Logger(AuthOrchestratorService.name);

  validatePayload(payload: AuthPayloadValidator): boolean {
    if (!payload.authId) {
      this.logger.warn('Missing authId in payload');
      return false;
    }

    if (!isValidAuthProvider(payload.authProvider)) {
      this.logger.warn('Invalid authProvider', { provider: payload.authProvider });
      return false;
    }

    return true;
  }
}

function isValidAuthProvider(
  provider: string,
): provider is AuthProvider {
  return Object.values(AuthProvider).includes(provider as AuthProvider);
}
