import { Injectable } from '@nestjs/common';

export interface ApiKeyValidationResult {
  apiKey: { id: string };
  project: { id: string; name: string; roles?: string[] };
  developer: { id: string; email: string };
}

/**
 * Validates API keys against the database or key management service.
 *
 * In a production deployment this would call an external key
 * management service or query the database. The current
 * implementation is a stub that validates against a hardcoded
 * test key so the e2e suite can run offline.
 */
@Injectable()
export class ApiKeyService {
  async validateApiKey(
    apiKey: string,
  ): Promise<ApiKeyValidationResult | null> {
    if (!apiKey) {
      return null;
    }

    // Stub: accept any key that starts with a known prefix
    if (apiKey.startsWith('mux_test_') || apiKey.startsWith('mux_live_')) {
      return {
        apiKey: { id: 'api-key-id' },
        project: { id: 'proj-id', name: 'proj-name', roles: [] },
        developer: { id: 'dev-id', email: 'dev@example.com' },
      };
    }

    return null;
  }

  async recordUsage(apiKeyId: string): Promise<void> {
    // Stub: no-op for offline testing
  }
}
