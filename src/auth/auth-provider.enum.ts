export enum AuthProvider {
  CLERK = 'CLERK',
  BETTER_AUTH = 'BETTER_AUTH',
}

export function isValidAuthProvider(provider: string): provider is AuthProvider {
  return Object.values(AuthProvider).includes(provider as AuthProvider);
}

export function getValidProviderNames(): string[] {
  return Object.values(AuthProvider);
}

/**
 * Plain data shape describing the fields the auth payload validator inspects.
 * This is intentionally an interface (not a class) so callers can pass plain
 * payload objects without constructing a validator instance.
 */
export interface AuthPayload {
  authId?: string;
  email?: string;
  displayName?: string;
  authProvider?: string;
  network?: string;
}
