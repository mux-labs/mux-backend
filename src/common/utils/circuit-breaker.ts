export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker "${name}" is open — failing fast`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures required to trip the circuit from CLOSED to OPEN. */
  failureThreshold?: number;
  /** How long the circuit stays OPEN before allowing a single HALF_OPEN trial call. */
  resetTimeoutMs?: number;
}

/**
 * Minimal in-memory circuit breaker (no external dependency).
 *
 * CLOSED: calls pass through; failures are counted, threshold trips to OPEN.
 * OPEN: calls fail fast with CircuitOpenError until resetTimeoutMs elapses.
 * HALF_OPEN: a single trial call is allowed through; success closes the
 * circuit, failure reopens it and resets the cooldown timer.
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(
    private readonly name: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30000;
  }

  getState(): CircuitState {
    if (
      this.state === CircuitState.OPEN &&
      Date.now() - this.openedAt >= this.resetTimeoutMs
    ) {
      this.state = CircuitState.HALF_OPEN;
    }
    return this.state;
  }

  /** Throws CircuitOpenError if the call should be short-circuited. */
  assertClosed(): void {
    if (this.getState() === CircuitState.OPEN) {
      throw new CircuitOpenError(this.name);
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = CircuitState.CLOSED;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    if (
      this.state === CircuitState.HALF_OPEN ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.state = CircuitState.OPEN;
      this.openedAt = Date.now();
    }
  }
}
