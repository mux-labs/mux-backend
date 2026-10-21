import {
  mainnetPaymentFlagSnapshot,
  resolveMainnetPaymentFlag,
} from './configuration';

describe('mainnetPaymentFlagSnapshot', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns exactly the documented key set for the testnet result', () => {
    const snapshot = mainnetPaymentFlagSnapshot(
      resolveMainnetPaymentFlag({ MAINNET_PAYMENT_ENABLED: 'false' }),
    );

    expect(Object.keys(snapshot).sort()).toEqual(
      ['denialCode', 'mainnetPaymentEnabled', 'network'].sort(),
    );
  });

  it('reports mainnet enabled and network mainnet for the mainnet-enabled result', () => {
    const snapshot = mainnetPaymentFlagSnapshot(
      resolveMainnetPaymentFlag({ MAINNET_PAYMENT_ENABLED: 'true' }),
    );

    expect(snapshot.mainnetPaymentEnabled).toBe(true);
    expect(snapshot.network).toBe('mainnet');
  });

  it('only contains primitive values', () => {
    const snapshot = mainnetPaymentFlagSnapshot(
      resolveMainnetPaymentFlag({ MAINNET_PAYMENT_ENABLED: 'false' }),
    );

    for (const value of Object.values(snapshot)) {
      expect(['string', 'boolean']).toContain(typeof value);
    }
  });

  it('never includes sentinel secrets from process.env when serialized', () => {
    const sentinels = {
      WALLET_ENCRYPTION_KEY: 'sentinel-wallet-encryption-key-1182',
      WEBHOOK_SIGNING_KEY: 'sentinel-webhook-signing-key-1182',
      DATABASE_URL: 'sentinel-database-url-1182',
    };

    Object.assign(process.env, sentinels);

    const snapshot = mainnetPaymentFlagSnapshot(
      resolveMainnetPaymentFlag({ MAINNET_PAYMENT_ENABLED: 'true' }),
    );
    const serialized = JSON.stringify(snapshot);

    for (const sentinel of Object.values(sentinels)) {
      expect(serialized).not.toContain(sentinel);
    }
  });
});
