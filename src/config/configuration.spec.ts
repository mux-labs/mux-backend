import {
  resolveMainnetPaymentFlag,
  mainnetPaymentFlagSnapshot,
  MAINNET_PAYMENT_FLAG_ERROR_CODES,
} from './configuration';

describe('resolveMainnetPaymentFlag (#965)', () => {
  it('returns disabled by default when no environment variables are set', () => {
    const flag = resolveMainnetPaymentFlag({});
    expect(flag.enabled).toBe(false);
    expect(flag.network).toBe('testnet');
    expect(flag.denialCode).toBe(MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED);
  });

  it('returns disabled on mainnet when no enable flag is set (deny-by-default)', () => {
    const flag = resolveMainnetPaymentFlag({ STELLAR_NETWORK: 'MAINNET' });
    expect(flag.enabled).toBe(false);
    expect(flag.network).toBe('mainnet');
    expect(flag.denialCode).toBe(MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED);
  });

  it('enables mainnet payments when canonical PAYMENT_MAINNET_ENABLED=true on mainnet', () => {
    const flag = resolveMainnetPaymentFlag({
      STELLAR_NETWORK: 'MAINNET',
      PAYMENT_MAINNET_ENABLED: 'true',
    });
    expect(flag.enabled).toBe(true);
    expect(flag.network).toBe('mainnet');
  });

  it('enables mainnet payments when legacy MAINNET_PAYMENT_ENABLED=true on mainnet', () => {
    const flag = resolveMainnetPaymentFlag({
      STELLAR_NETWORK: 'MAINNET',
      MAINNET_PAYMENT_ENABLED: 'true',
    });
    expect(flag.enabled).toBe(true);
  });

  it('canonical PAYMENT_MAINNET_ENABLED takes precedence over legacy aliases', () => {
    const flag = resolveMainnetPaymentFlag({
      STELLAR_NETWORK: 'MAINNET',
      PAYMENT_MAINNET_ENABLED: 'false',
      MAINNET_PAYMENT_ENABLED: 'true',
    });
    expect(flag.enabled).toBe(false);
  });

  it('snapshots flag state without secrets', () => {
    const flag = resolveMainnetPaymentFlag({
      STELLAR_NETWORK: 'MAINNET',
      PAYMENT_MAINNET_ENABLED: 'true',
    });
    const snapshot = mainnetPaymentFlagSnapshot(flag);
    expect(snapshot).toEqual({
      mainnetPaymentEnabled: true,
      network: 'mainnet',
      denialCode: MAINNET_PAYMENT_FLAG_ERROR_CODES.DISABLED,
    });
  });
});
