import {
  MAINNET_PAYMENT_FLAG_ERROR_CODES,
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

    expect(Object.keys(snapshot).sort()
  mainnetPaymentFlagSnapshot,
  resolveMainnetPaymentFlag,
} from './configuration';

describe('resolveMainnetPaymentFlag', () => {
  it('returns disabled/testnet/DISABLED when no env is set', () => {
    const flag = resolveMainnetPaymentFlag({});
    expect(flag.enabled).toBe(false);
    expect(flag.network).toBe('');
    expect(flag.denialCode).toBe(MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED);
  });

  it('returns disabled/mainnet/DISABLED when mainnet is set but the flag is unset', () => {
    const flag = resolveMainnetPaymentFlag({ STELLAR_NETWORK: 'mainnet' });
    expect(flag.enabled).toBe(false);
    expect(flag.network).toBe('mainnet');
    expect(flag.denialCode).toBe(MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED);
  });

  it('returns enabled/mainnet with no denial code when the flag is true', () => {
    const flag = resolveMainnetPaymentFlag({
      STELLAR_NETWORK: 'mainnet',
      MAINNET_PAYMENT_ENABLED: 'true',
    });
    expect(flag.enabled).toBe(true);
    expect(flag.network).toBe('mainnet');
    expect(flag.denialCode).toBeUndefined();
  });

  it('falls back to SOROBAN_NETWORK for the mainnet check', () => {
    const flag = resolveMainnetPaymentFlag({
      SOROBAN_NETWORK: 'mainnet',
      MAINNET_PAYMENT_ENABLED: 'true',
    });
    expect(flag.enabled).toBe(true);
    expect(flag.network).toBe('mainnet');
    expect(flag.denialCode).toBeUndefined();
  });

  it('treats an unrecognized MAINNET_PAYMENT_ENABLED value as disabled', () => {
    const flag = resolveMainnetPaymentFlag({
      STELLAR_NETWORK: 'mainnet',
      MAINNET_PAYMENT_ENABLED: 'maybe',
    });
    expect(flag.enabled).toBe(false);
    expect(flag.network).toBe('mainnet');
    expect(flag.denialCode).toBe(MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED);
  });
});

describe('mainnetPaymentFlagSnapshot', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('omits the denial code when the flag is enabled', () => {
    const snapshot = mainnetPaymentFlagSnapshot({
      STELLAR_NETWORK: 'mainnet',
      MAINNET_PAYMENT_ENABLED: 'true',
    });
    expect(snapshot).toEqual({ enabled: true, network: 'mainnet' });
    expect('denialCode' in snapshot).toBe(false);
  });

  it('includes the DISABLED denial code when the flag is disabled', () => {
    const snapshot = mainnetPaymentFlagSnapshot({ STELLAR_NETWORK: 'mainnet' });
    expect(snapshot).toEqual({
      enabled: false,
      network: 'mainnet',
      denialCode: MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED,
    });
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
