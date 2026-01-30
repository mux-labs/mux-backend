/**
 * Domain model for API Keys
 */

export enum ApiKeyStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
  SUSPENDED = 'SUSPENDED',
}

export interface ApiKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastFour: string;
  projectId: string;
  status: ApiKeyStatus;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Developer {
  id: string;
  email: string;
  name?: string | null;
  company?: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  developerId: string;
  status: string;
  environment: string;
  rateLimitRpm: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Validated API key context extracted from request
 */
export interface ApiKeyContext {
  apiKey: ApiKey;
  project: Project;
  developer: Developer;
}

/**
 * Allowed status transitions for API keys
 */
const ALLOWED_TRANSITIONS: Readonly<
  Record<ApiKeyStatus, ReadonlySet<ApiKeyStatus>>
> = {
  [ApiKeyStatus.ACTIVE]: new Set([
    ApiKeyStatus.REVOKED,
    ApiKeyStatus.EXPIRED,
    ApiKeyStatus.SUSPENDED,
  ]),
  [ApiKeyStatus.SUSPENDED]: new Set([
    ApiKeyStatus.ACTIVE,
    ApiKeyStatus.REVOKED,
  ]),
  [ApiKeyStatus.EXPIRED]: new Set([]), // Cannot transition from expired
  [ApiKeyStatus.REVOKED]: new Set([]), // Cannot transition from revoked
};

export function canTransitionApiKeyStatus(
  from: ApiKeyStatus,
  to: ApiKeyStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].has(to);
}
