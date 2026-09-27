import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'crypto';

/**
 * Network scoping and the stable `NETWORK_MISMATCH` error code (#943).
 *
 * Money-path invariant: a request may only ever act on the network its
 * credential/resource is scoped to. A TESTNET-scoped API key must not be able
 * to drive a MAINNET write, and a MAINNET payment must never be silently
 * reinterpreted as TESTNET. Enforcement happens *before* any write and fails
 * closed, so a misconfiguration can never move funds on the wrong chain.
 *
 * Unscoped (`null`/`undefined`) always means "all networks" — that is the
 * documented meaning of `ApiKey.network = null` in `prisma/schema.prisma`, not
 * an unknown value to be guessed at.
 *
 * Clients branch on these stable codes, never on messages.
 * Cross-links: docs/NETWORK-SCOPING.md, docs/API-VERSIONING.md.
 */

/** Networks the backend recognises. Mirrors `WalletNetwork` in the schema. */
export const ScopedNetwork = {
  TESTNET: 'TESTNET',
  MAINNET: 'MAINNET',
} as const;

export type ScopedNetworkValue =
  (typeof ScopedNetwork)[keyof typeof ScopedNetwork];

/**
 * Stable, typed error codes for network scoping.
 *
 * Add new codes; never repurpose one. `NETWORK_MISMATCH` is the code a client
 * receives when it presents a credential scoped to network A while targeting
 * network B.
 */
export const NetworkErrorCode = {
  /** Credential/resource is scoped to a different network than the request. */
  NETWORK_MISMATCH: 'NETWORK_MISMATCH',

  /** The value is not a recognised network name at all. */
  INVALID_NETWORK: 'INVALID_NETWORK',
} as const;

export type NetworkErrorCode =
  (typeof NetworkErrorCode)[keyof typeof NetworkErrorCode];

/**
 * Parses a raw network value into a canonical, upper-cased network.
 *
 * Returns `null` for an unrecognised value so callers can fail closed with
 * `INVALID_NETWORK` instead of silently treating a typo as "unscoped".
 */
export function normalizeNetwork(value: unknown): ScopedNetworkValue | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toUpperCase();
  if (
    normalized === ScopedNetwork.TESTNET ||
    normalized === ScopedNetwork.MAINNET
  ) {
    return normalized;
  }
  return null;
}

/**
 * Whether a request targeting `requested` is permitted by a scope.
 *
 * - An unscoped credential (`null`/`undefined`) permits every network.
 * - A scoped credential permits exactly its own network.
 * - An unparseable `requested` value never matches, so bad input is refused
 *   rather than defaulted.
 */
export function networksMatch(
  scope: ScopedNetworkValue | null | undefined,
  requested: ScopedNetworkValue | null | undefined,
): boolean {
  if (scope === null || scope === undefined) {
    return true;
  }
  if (requested === null || requested === undefined) {
    return false;
  }
  return scope === requested;
}

export interface NetworkScopeCheck {
  /** Network the credential/resource is scoped to; null = all networks. */
  scope: ScopedNetworkValue | null | undefined;
  /** Network the request targets. */
  requested: string | null | undefined;
  /** Correlation id echoed back to the caller and into logs. */
  correlationId?: string;
  /** Ops-safe label describing what owns the scope (e.g. "api-key"). */
  subject?: string;
}

/**
 * Throws unless `requested` matches `scope`.
 *
 * Fail-closed:
 * - an unrecognised request network is a 400 `INVALID_NETWORK`;
 * - a recognised-but-different network is a 403 `NETWORK_MISMATCH`.
 *
 * Never include the credential itself in the error or the logs: `subject` is a
 * static label such as `"api-key"`, never a key, token, or seed.
 */
export function assertNetworkMatch(check: NetworkScopeCheck): void {
  const { scope, requested, subject = 'credential' } = check;

  // Every refusal carries a correlation id so ops can join it to the request
  // even when the caller did not supply one.
  const correlationId = check.correlationId ?? randomUUID();

  // Unscoped: every network is allowed, nothing to compare.
  if (scope === null || scope === undefined) {
    return;
  }

  const normalizedRequested = normalizeNetwork(requested);

  if (normalizedRequested === null) {
    throw new BadRequestException({
      code: NetworkErrorCode.INVALID_NETWORK,
      message: `network must be one of: ${ScopedNetwork.TESTNET}, ${ScopedNetwork.MAINNET}`,
      correlationId,
    });
  }

  if (normalizedRequested !== scope) {
    throw new ForbiddenException({
      code: NetworkErrorCode.NETWORK_MISMATCH,
      message: `This ${subject} is scoped to ${scope} and cannot be used on ${normalizedRequested}`,
      correlationId,
    });
  }
}

/**
 * Best-effort extraction of the network a request targets.
 *
 * Checked in order of specificity: an explicit `x-mux-network` header wins so
 * an operator can pin the network at the edge, then the body, then route
 * params, then the query string. Returns `undefined` when the request does not
 * name a network at all, which is a no-op for unscoped credentials.
 */
export function extractRequestedNetwork(request: {
  headers?: Record<string, unknown>;
  body?: Record<string, unknown>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): string | undefined {
  const header = request.headers?.['x-mux-network'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header;
  }

  const candidates = [
    request.body?.network,
    request.params?.network,
    request.query?.network,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return undefined;
}
