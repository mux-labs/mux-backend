/**
 * Latency SLO definitions for the Mux Backend API.
 *
 * Each SLO specifies:
 *  - The route pattern it applies to (used for tag-based grouping)
 *  - `thresholdMs` – the maximum acceptable p99 latency in milliseconds
 *  - `targetCompliance` – the fraction of requests that must meet the
 *    threshold (e.g. 0.99 = 99 %).
 *
 * These values are intentionally conservative for an MVP; tighten as
 * observability data accumulates.
 */

export interface SloDefinition {
  /** Human-readable name for the SLO, used as a metrics label. */
  name: string;

  /**
   * Glob-style route prefix that requests are matched against.
   * Matching is prefix-based (e.g. "/wallets" matches /wallets/:id).
   */
  routePrefix: string;

  /** HTTP method to match ("*" = any). */
  method: string;

  /** Latency threshold in milliseconds. */
  thresholdMs: number;

  /** Minimum fraction of requests that must be within the threshold. */
  targetCompliance: number;
}

export const DEFAULT_SLOS: SloDefinition[] = [
  {
    name: 'wallet_read',
    routePrefix: '/wallets',
    method: 'GET',
    thresholdMs: 200,
    targetCompliance: 0.99,
  },
  {
    name: 'wallet_write',
    routePrefix: '/wallets',
    method: '*',
    thresholdMs: 500,
    targetCompliance: 0.95,
  },
  {
    name: 'transaction_read',
    routePrefix: '/transactions',
    method: 'GET',
    thresholdMs: 300,
    targetCompliance: 0.99,
  },
  {
    name: 'transaction_write',
    routePrefix: '/transactions',
    method: '*',
    thresholdMs: 1000,
    targetCompliance: 0.95,
  },
  {
    name: 'balance_read',
    routePrefix: '/balances',
    method: 'GET',
    thresholdMs: 300,
    targetCompliance: 0.99,
  },
  {
    name: 'auth',
    routePrefix: '/auth',
    method: '*',
    thresholdMs: 500,
    targetCompliance: 0.99,
  },
  {
    name: 'global',
    routePrefix: '/',
    method: '*',
    thresholdMs: 1000,
    targetCompliance: 0.99,
  },
];

export interface SloObservation {
  route: string;
  method: string;
  durationMs: number;
  timestamp: Date;
}

export interface SloComplianceResult {
  /** SLO name from SloDefinition. */
  sloName: string;
  /** Threshold in milliseconds. */
  thresholdMs: number;
  /** Target compliance fraction (0–1). */
  targetCompliance: number;
  /** Measured compliance fraction over the observed window. */
  measuredCompliance: number;
  /** Whether the SLO is currently being met. */
  compliant: boolean;
  /** Total requests counted in this window. */
  totalRequests: number;
  /** Requests within threshold. */
  requestsWithinThreshold: number;
  /** Approximate p50 latency in ms. */
  p50Ms: number;
  /** Approximate p95 latency in ms. */
  p95Ms: number;
  /** Approximate p99 latency in ms. */
  p99Ms: number;
}
