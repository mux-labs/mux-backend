import { ErrorCode } from '../common/dto/error-envelope.dto';
import {
  LEGACY_MAINNET_ENABLED_ENVS,
  MAINNET_HORIZON_URL_ENV,
  PAYMENT_DRY_RUN_ENABLED_ENV,
  PAYMENT_KILL_SWITCH_ENV,
  PAYMENT_MAINNET_ENABLED_ENV,
  decideLiveSubmission,
  parseFlagBoolean,
  paymentMoneyPathFlagSnapshot,
  resolvePaymentMoneyPathFlags,
} from './payment-money-path.policy';
import { PaymentNetwork } from './payment-money-path.model';

const CANONICAL_FLAGS = [
  PAYMENT_DRY_RUN_ENABLED_ENV,
  PAYMENT_KILL_SWITCH_ENV,
  PAYMENT_MAINNET_ENABLED_ENV,
  MAINNET_HORIZON_URL_ENV,
  'STELLAR_NETWORK',
  'SOROBAN_NETWORK',
  'NODE_ENV',
  ...LEGACY_MAINNET_ENABLED_ENVS,
];

describe('payment money-path policy', () => {
  beforeEach(() => {
    CANONICAL_FLAGS.forEach((key) => delete process.env[key]);
  });

  afterEach(() => {
    CANONICAL_FLAGS.forEach((key) => delete process.env[key]);
  });

  describe('resolvePaymentMoneyPathFlags', () => {
    it('is deny-by-default: every flag off when nothing is set', () => {
      const flags = resolvePaymentMoneyPathFlags({});

      expect(flags.killSwitchEngaged).toBe(false);
      expect(flags.dryRunEnabled).toBe(false);
      expect(flags.mainnetEnabled).toBe(false);
      expect(flags.mainnetMisconfigured).toBe(false);
      expect(flags.network).toBe(PaymentNetwork.TESTNET);
      expect(flags.sources).toEqual({
        killSwitch: 'unset',
        dryRun: 'unset',
        mainnet: 'unset',
      });
    });

    it.each([PAYMENT_KILL_SWITCH_ENV, PAYMENT_DRY_RUN_ENABLED_ENV])(
      '%s only turns on for an explicit truthy value',
      (envKey) => {
        for (const value of ['1', 'true', 'TRUE ', 'yes', 'on']) {
          const flags = resolvePaymentMoneyPathFlags({ [envKey]: value });
          const enabled =
            envKey === PAYMENT_KILL_SWITCH_ENV
              ? flags.killSwitchEngaged
              : flags.dryRunEnabled;
          expect(enabled).toBe(true);
        }

        for (const value of ['', 'false', '0', 'no', 'maybe', 'ture']) {
          const flags = resolvePaymentMoneyPathFlags({ [envKey]: value });
          const enabled =
            envKey === PAYMENT_KILL_SWITCH_ENV
              ? flags.killSwitchEngaged
              : flags.dryRunEnabled;
          expect(enabled).toBe(false);
        }
      },
    );

    it('reads the canonical mainnet var', () => {
      const flags = resolvePaymentMoneyPathFlags({
        [PAYMENT_MAINNET_ENABLED_ENV]: 'true',
      });

      expect(flags.mainnetEnabled).toBe(true);
      expect(flags.sources.mainnet).toBe(PAYMENT_MAINNET_ENABLED_ENV);
    });

    it('falls back to the documented legacy alias', () => {
      const flags = resolvePaymentMoneyPathFlags({
        MAINNET_PAYMENTS_ENABLED: 'true',
      });

      expect(flags.mainnetEnabled).toBe(true);
      expect(flags.sources.mainnet).toBe('MAINNET_PAYMENTS_ENABLED');
    });

    it('lets an explicit canonical `false` beat a legacy `true`', () => {
      const flags = resolvePaymentMoneyPathFlags({
        [PAYMENT_MAINNET_ENABLED_ENV]: 'false',
        MAINNET_PAYMENTS_ENABLED: 'true',
      });

      expect(flags.mainnetEnabled).toBe(false);
      expect(flags.sources.mainnet).toBe(PAYMENT_MAINNET_ENABLED_ENV);
    });

    it('treats an unparseable mainnet value as disabled', () => {
      const flags = resolvePaymentMoneyPathFlags({
        [PAYMENT_MAINNET_ENABLED_ENV]: 'ture',
      });

      expect(flags.mainnetEnabled).toBe(false);
    });

    it('flags a production mainnet deployment with no mainnet Horizon URL', () => {
      const misconfigured = resolvePaymentMoneyPathFlags({
        NODE_ENV: 'production',
        [PAYMENT_MAINNET_ENABLED_ENV]: 'true',
      });
      const configured = resolvePaymentMoneyPathFlags({
        NODE_ENV: 'production',
        [PAYMENT_MAINNET_ENABLED_ENV]: 'true',
        [MAINNET_HORIZON_URL_ENV]: 'https://horizon.stellar.org',
      });
      const off = resolvePaymentMoneyPathFlags({
        NODE_ENV: 'production',
        [PAYMENT_MAINNET_ENABLED_ENV]: 'false',
      });

      expect(misconfigured.mainnetMisconfigured).toBe(true);
      expect(configured.mainnetMisconfigured).toBe(false);
      expect(off.mainnetMisconfigured).toBe(false);
    });
  });

  describe('decideLiveSubmission', () => {
    it('never gates testnet', () => {
      const flags = resolvePaymentMoneyPathFlags({});
      expect(decideLiveSubmission(PaymentNetwork.TESTNET, flags).allowed).toBe(
        true,
      );
    });

    it('blocks mainnet value while the flag is off', () => {
      const flags = resolvePaymentMoneyPathFlags({
        [PAYMENT_MAINNET_ENABLED_ENV]: 'false',
      });
      const decision = decideLiveSubmission(PaymentNetwork.MAINNET, flags);

      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe(ErrorCode.PAYMENT_MAINNET_DISABLED);
    });

    it('prefers the misconfiguration refusal over the plain denial', () => {
      const flags = resolvePaymentMoneyPathFlags({
        NODE_ENV: 'production',
        [PAYMENT_MAINNET_ENABLED_ENV]: 'true',
      });
      const decision = decideLiveSubmission(PaymentNetwork.MAINNET, flags);

      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe(ErrorCode.PAYMENT_MAINNET_MISCONFIGURED);
    });

    it('allows mainnet value only when explicitly enabled', () => {
      const flags = resolvePaymentMoneyPathFlags({
        [PAYMENT_MAINNET_ENABLED_ENV]: 'true',
        [MAINNET_HORIZON_URL_ENV]: 'https://horizon.stellar.org',
      });

      expect(decideLiveSubmission(PaymentNetwork.MAINNET, flags).allowed).toBe(
        true,
      );
    });
  });

  it('snapshots booleans and env var names only — never values', () => {
    const snapshot = paymentMoneyPathFlagSnapshot(
      resolvePaymentMoneyPathFlags({
        [PAYMENT_MAINNET_ENABLED_ENV]: 'true',
        [PAYMENT_DRY_RUN_ENABLED_ENV]: 'true',
        [PAYMENT_KILL_SWITCH_ENV]: 'false',
      }),
    );

    for (const value of Object.values(snapshot)) {
      expect(typeof value === 'string' || typeof value === 'boolean').toBe(
        true,
      );
    }
    expect(snapshot.mainnetSource).toBe(PAYMENT_MAINNET_ENABLED_ENV);
    expect(snapshot.killSwitchSource).toBe(PAYMENT_KILL_SWITCH_ENV);
  });

  it('parseFlagBoolean is fail-closed on anything but an explicit truthy', () => {
    expect(parseFlagBoolean(undefined)).toBe(false);
    expect(parseFlagBoolean('')).toBe(false);
    expect(parseFlagBoolean('1')).toBe(true);
    expect(parseFlagBoolean('yes')).toBe(true);
    expect(parseFlagBoolean('NO')).toBe(false);
    expect(parseFlagBoolean('2')).toBe(false);
  });
});
