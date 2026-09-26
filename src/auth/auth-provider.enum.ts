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
