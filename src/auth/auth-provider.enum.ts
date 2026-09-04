/**
 * Supported authentication providers
 *
 * These represent the external identity providers that Mux Backend
 * trusts for user authentication. Each provider has a specific JWT
 * verification strategy and configuration.
 */
export enum AuthProvider {
  CLERK = 'CLERK',
  BETTER_AUTH = 'BETTER_AUTH',
}

/**
 * Maps provider enum values to their configuration environment variable names
 */
export const AuthProviderConfig: Record<AuthProvider, { publicKeyEnvVar: string; jwksUrlEnvVar: string }> = {
  [AuthProvider.CLERK]: {
    publicKeyEnvVar: 'CLERK_JWT_PUBLIC_KEY',
    jwksUrlEnvVar: 'CLERK_JWKS_URL',
  },
  [AuthProvider.BETTER_AUTH]: {
    publicKeyEnvVar: 'BETTER_AUTH_JWT_PUBLIC_KEY',
    jwksUrlEnvVar: 'BETTER_AUTH_JWKS_URL',
  },
};

/**
 * Returns all valid provider names as a string for error messages
 */
export function getValidProviderNames(): string {
  return Object.values(AuthProvider).join(', ');
}

/**
 * Validates that a given provider string is a known auth provider
 *
 * @param provider - The provider name to validate (case-sensitive)
 * @returns true if the provider is supported, false otherwise
 */
export function isValidAuthProvider(provider: string): provider is AuthProvider {
  return Object.values(AuthProvider).includes(provider as AuthProvider);
}
