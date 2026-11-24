import { BalanceIndexerErrorCode } from './balance-indexer.error-codes';

/**
 * The published wire values. Clients (wallets, ops dashboards) branch on these
 * strings, so each one is pinned: renaming or repurposing a code must fail
 * here. New codes may be added without touching this table.
 */
const PUBLISHED_CODES = {
  INVALID_INPUT: 'BALANCE_INVALID_INPUT',
  WALLET_NOT_FOUND: 'BALANCE_WALLET_NOT_FOUND',
  CURSOR_REGRESSION: 'BALANCE_CURSOR_REGRESSION',
  NOT_AUTHORIZED: 'BALANCE_NOT_AUTHORIZED',
  INSUFFICIENT_ROLE: 'BALANCE_INSUFFICIENT_ROLE',
  DEPENDENCY_UNAVAILABLE: 'BALANCE_DEPENDENCY_UNAVAILABLE',
  DEPENDENCY_MALFORMED: 'BALANCE_DEPENDENCY_MALFORMED',
  FEATURE_FLAG_DISABLED: 'BALANCE_FEATURE_FLAG_DISABLED',
  BATCH_TOO_LARGE: 'BALANCE_BATCH_TOO_LARGE',
} as const;

describe('BalanceIndexerErrorCode', () => {
  describe('Authz codes', () => {
    it('keeps NOT_AUTHORIZED stable', () => {
      expect(BalanceIndexerErrorCode.NOT_AUTHORIZED).toBe(
        'BALANCE_NOT_AUTHORIZED',
      );
    });

    it('keeps INSUFFICIENT_ROLE stable', () => {
      expect(BalanceIndexerErrorCode.INSUFFICIENT_ROLE).toBe(
        'BALANCE_INSUFFICIENT_ROLE',
      );
    });

    it('keeps the two authz denials distinguishable', () => {
      expect(BalanceIndexerErrorCode.NOT_AUTHORIZED).not.toBe(
        BalanceIndexerErrorCode.INSUFFICIENT_ROLE,
      );
    });

    it('never aliases an authz code onto another failure class', () => {
      const authz = new Set<string>([
        BalanceIndexerErrorCode.NOT_AUTHORIZED,
        BalanceIndexerErrorCode.INSUFFICIENT_ROLE,
      ]);
      const others = Object.entries(BalanceIndexerErrorCode)
        .filter(
          ([key]) => key !== 'NOT_AUTHORIZED' && key !== 'INSUFFICIENT_ROLE',
        )
        .map(([, value]) => value);

      for (const value of others) {
        expect(authz.has(value)).toBe(false);
      }
    });
  });

  it('never repurposes or removes a published code', () => {
    expect(BalanceIndexerErrorCode).toMatchObject(PUBLISHED_CODES);
  });

  it('maps every key to a distinct value so clients can branch unambiguously', () => {
    const values = Object.values(BalanceIndexerErrorCode);

    expect(new Set(values).size).toBe(values.length);
  });

  it('namespaces every code under BALANCE_ in SCREAMING_SNAKE_CASE', () => {
    for (const value of Object.values(BalanceIndexerErrorCode)) {
      expect(value).toMatch(/^BALANCE_[A-Z0-9]+(_[A-Z0-9]+)*$/);
    }
  });

  it('exposes typed codes usable as the BalanceIndexerErrorCode type', () => {
    const code: BalanceIndexerErrorCode =
      BalanceIndexerErrorCode.NOT_AUTHORIZED;

    expect(Object.values(BalanceIndexerErrorCode)).toContain(code);
  });
});
