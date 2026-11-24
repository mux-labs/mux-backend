import configuration, {
  MAINNET_PAYMENT_FLAG_ERROR_CODES,
  mainnetPaymentFlagSnapshot,
  parseBoolean,
  resolveIdempotencyCleanupConfig,
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

  it('never gates testnet payments on the flag (testnet stays enabled)', () => {
    const flag = resolveMainnetPaymentFlag({
      STELLAR_NETWORK: 'testnet',
      MAINNET_PAYMENT_ENABLED: 'false',
    });
    expect(flag.network).toBe('testnet');
    expect(flag.denialCode).toBeUndefined();
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

describe('resolveIdempotencyCleanupConfig / parseBoolean (issue #1328)', () => {
  it('applies the documented defaults when a variable is absent', () => {
    const config = resolveIdempotencyCleanupConfig({});

    expect(config).toEqual({
      enabled: false,
      intervalMs: 3_600_000,
      batchSize: 1000,
    });
  });

  it('parseBoolean returns the fallback when the value is absent', () => {
    expect(parseBoolean(undefined, false)).toBe(false);
    expect(parseBoolean(undefined, true)).toBe(true);
    expect(parseBoolean('', false)).toBe(false);
  });

  it('parseBoolean honors explicit boolean-like values instead of the fallback', () => {
    expect(parseBoolean('true', false)).toBe(true);
    expect(parseBoolean('1', false)).toBe(true);
    expect(parseBoolean('yes', false)).toBe(true);
    expect(parseBoolean('on', false)).toBe(true);
    expect(parseBoolean('false', true)).toBe(false);
    expect(parseBoolean('0', true)).toBe(false);
    expect(parseBoolean('no', true)).toBe(false);
    expect(parseBoolean('off', true)).toBe(false);
  });

  it('parseBoolean falls back on unrecognized values (validated at boot elsewhere)', () => {
    expect(parseBoolean('garbage', true)).toBe(true);
    expect(parseBoolean('garbage', false)).toBe(false);
  });
});

describe('registerAs configuration snapshot (issue #1329)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('produces an ops-safe, secret-free snapshot that never includes keys, JWTs, or webhook secrets', () => {
    const sentinels = {
      WALLET_ENCRYPTION_KEY: 'sentinel-wallet-key-1329',
      JWT_SECRET: 'sentinel-jwt-1329',
      WEBHOOK_SECRET: 'sentinel-webhook-secret-1329',
      MAINNET_PAYMENT_ENABLED: 'true',
      STELLAR_NETWORK: 'mainnet',
    };
    Object.assign(process.env, sentinels);

    const config = configuration();
    const snapshot = mainnetPaymentFlagSnapshot(config.mainnetPayment);
    const serialized = JSON.stringify({ config, snapshot });

    expect(Object.keys(snapshot).sort()).toEqual(
      ['mainnetPaymentEnabled', 'network'].sort(),
    );
    for (const value of [sentinels.WALLET_ENCRYPTION_KEY, sentinels.JWT_SECRET, sentinels.WEBHOOK_SECRET]) {
      expect(serialized).not.toContain(value);
    }
  });
});
