import { ServiceUnavailableException } from '@nestjs/common';
import {
  AssetMatrixErrorCode,
  AssetMatrixService,
  MULTI_ASSET_PAYMENTS_ENABLED_ENV,
  PaymentAssetType,
  PaymentNetwork,
} from './asset-matrix';
import type { AssetMatrixEntry } from './asset-matrix';
import { MetricsService } from '../common/metrics/metrics.service';

const MAINNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const TESTNET_USDC_ISSUER =
  'GBTQVF7QXZ4M3XK7M2XFP2JH4CJ2H2ZK3ZQ2XW2ZK3ZQ2XW2ZK3ZQ';
const CORRELATION_ID = 'corr-1';

const XLM: AssetMatrixEntry = {
  code: 'XLM',
  type: PaymentAssetType.NATIVE,
  issuer: null,
  mainnetEnabled: true,
  decimals: 7,
};

describe('AssetMatrixService', () => {
  let service: AssetMatrixService;
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    process.env[MULTI_ASSET_PAYMENTS_ENABLED_ENV] = 'true';
    metrics = { incrementCounter: jest.fn() };
    service = new AssetMatrixService(metrics as unknown as MetricsService);
  });

  afterEach(() => {
    delete process.env[MULTI_ASSET_PAYMENTS_ENABLED_ENV];
    jest.restoreAllMocks();
  });

  describe('native asset', () => {
    it('treats an absent asset code as native XLM', () => {
      const asset = service.resolveAsset({
        network: PaymentNetwork.MAINNET,
        correlationId: CORRELATION_ID,
      });

      expect(asset).toEqual({
        type: PaymentAssetType.NATIVE,
        code: null,
        issuer: null,
      });
    });

    it('accepts an explicit XLM code', () => {
      const asset = service.resolveAsset({
        assetCode: 'XLM',
        network: PaymentNetwork.MAINNET,
        correlationId: CORRELATION_ID,
      });

      expect(asset.type).toBe(PaymentAssetType.NATIVE);
      expect(asset.issuer).toBeNull();
    });

    it('rejects native XLM carrying an issuer', () => {
      // Otherwise a caller could assert a "native" asset that is not native.
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'XLM',
            assetIssuer: MAINNET_USDC_ISSUER,
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.ISSUER_MISMATCH,
      );
    });

    it('rejects an issuer with no asset code', () => {
      expectCode(
        () =>
          service.resolveAsset({
            assetIssuer: MAINNET_USDC_ISSUER,
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.INVALID_INPUT,
      );
    });
  });

  describe('credit assets', () => {
    it('resolves a mainnet credit asset by code and issuer', () => {
      const asset = service.resolveAsset({
        assetCode: 'USDC',
        assetIssuer: MAINNET_USDC_ISSUER,
        network: PaymentNetwork.MAINNET,
        correlationId: CORRELATION_ID,
      });

      expect(asset).toEqual({
        type: PaymentAssetType.CREDIT_ALPHANUM4,
        code: 'USDC',
        issuer: MAINNET_USDC_ISSUER,
      });
    });

    it('refuses an asset code that is not in the matrix', () => {
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'SCAM',
            assetIssuer: MAINNET_USDC_ISSUER,
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.UNKNOWN_ASSET,
      );
    });

    it('refuses a known code paired with an unknown issuer', () => {
      // This is the look-alike token case: a real code, an attacker's issuer.
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'USDC',
            assetIssuer:
              'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.ISSUER_MISMATCH,
      );
    });

    it('never echoes the rejected issuer back to the client', () => {
      try {
        service.resolveAsset({
          assetCode: 'USDC',
          assetIssuer: 'GATTACKERISSUER',
          network: PaymentNetwork.MAINNET,
          correlationId: CORRELATION_ID,
        });
        throw new Error('expected rejection');
      } catch (err) {
        // The issuer is attacker-supplied; reflecting it invites log/UI spoofing.
        expect(
          JSON.stringify((err as { response: unknown }).response),
        ).not.toContain('GATTACKERISSUER');
      }
    });

    it('requires an issuer for a credit asset', () => {
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'USDC',
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.ISSUER_MISMATCH,
      );
    });
  });

  describe('network enforcement (testnet vs mainnet misconfig)', () => {
    it('refuses a testnet-only asset on mainnet', () => {
      // The code and issuer are valid, but the asset is not mainnet-enabled.
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'USDC',
            assetIssuer: TESTNET_USDC_ISSUER,
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.ASSET_NOT_ENABLED,
      );
    });

    it('accepts the testnet asset on testnet', () => {
      const asset = service.resolveAsset({
        assetCode: 'USDC',
        assetIssuer: TESTNET_USDC_ISSUER,
        network: PaymentNetwork.TESTNET,
        correlationId: CORRELATION_ID,
      });

      expect(asset.issuer).toBe(TESTNET_USDC_ISSUER);
    });

    it('lists only mainnet-enabled assets for mainnet', () => {
      const mainnet = service.listSupportedAssets(PaymentNetwork.MAINNET);
      expect(mainnet.every((entry) => entry.mainnetEnabled)).toBe(true);
    });

    it('lists testnet-only assets for testnet', () => {
      const testnet = service.listSupportedAssets(PaymentNetwork.TESTNET);
      expect(testnet.some((entry) => !entry.mainnetEnabled)).toBe(true);
    });
  });

  describe('kill-switch', () => {
    it('refuses credit assets when the flag is unset', () => {
      // `resolveAsset` is synchronous, so the exception surfaces on the call
      // itself rather than as a rejected promise.
      delete process.env[MULTI_ASSET_PAYMENTS_ENABLED_ENV];

      expect(() =>
        service.resolveAsset({
          assetCode: 'USDC',
          assetIssuer: MAINNET_USDC_ISSUER,
          network: PaymentNetwork.MAINNET,
          correlationId: CORRELATION_ID,
        }),
      ).toThrow(ServiceUnavailableException);
    });

    it('still allows native XLM when the flag is off', () => {
      // The flag gates new asset exposure; it must not break the money path.
      delete process.env[MULTI_ASSET_PAYMENTS_ENABLED_ENV];

      const asset = service.resolveAsset({
        assetCode: 'XLM',
        network: PaymentNetwork.MAINNET,
        correlationId: CORRELATION_ID,
      });

      expect(asset.type).toBe(PaymentAssetType.NATIVE);
    });

    it('treats a non-truthy flag value as disabled', () => {
      process.env[MULTI_ASSET_PAYMENTS_ENABLED_ENV] = 'yes';
      expect(service.isMultiAssetEnabled()).toBe(false);
    });
  });

  describe('amount validation', () => {
    it('accepts a whole-unit amount', () => {
      expect(service.validateAmount('1000000', XLM, CORRELATION_ID)).toBe(
        '1000000',
      );
    });

    it('accepts the maximum 7-decimal precision', () => {
      expect(service.validateAmount('1.0000001', XLM, CORRELATION_ID)).toBe(
        '1.0000001',
      );
    });

    it('refuses more precision than the asset allows', () => {
      // Truncating here would send a different amount than the user asked for.
      expectCode(
        () => service.validateAmount('1.00000001', XLM, CORRELATION_ID),
        AssetMatrixErrorCode.AMOUNT_INVALID,
      );
    });

    it('refuses a zero amount', () => {
      expectCode(
        () => service.validateAmount('0', XLM, CORRELATION_ID),
        AssetMatrixErrorCode.AMOUNT_INVALID,
      );
      expectCode(
        () => service.validateAmount('0.0000000', XLM, CORRELATION_ID),
        AssetMatrixErrorCode.AMOUNT_INVALID,
      );
    });

    it('refuses a negative amount', () => {
      expectCode(
        () => service.validateAmount('-1', XLM, CORRELATION_ID),
        AssetMatrixErrorCode.AMOUNT_INVALID,
      );
    });

    it('refuses a non-numeric amount', () => {
      expectCode(
        () => service.validateAmount('abc', XLM, CORRELATION_ID),
        AssetMatrixErrorCode.AMOUNT_INVALID,
      );
    });

    it('normalizes trailing zeros so equal amounts compare equal', () => {
      expect(service.validateAmount('100.0000000', XLM, CORRELATION_ID)).toBe(
        '100',
      );
      expect(service.validateAmount('100.5', XLM, CORRELATION_ID)).toBe(
        '100.5',
      );
    });

    it('preserves precision on a very large amount', () => {
      // Well beyond 2^53: a float would silently lose the trailing digits.
      const huge = '9007199254740993';
      expect(service.validateAmount(huge, XLM, CORRELATION_ID)).toBe(huge);
    });

    it('accepts a numeric amount sent in exponent form', () => {
      // 0.0000001 stringifies as 1e-7; a client sending that is legitimate.
      expect(service.validateAmount(0.0000001, XLM, CORRELATION_ID)).toBe(
        '0.0000001',
      );
    });

    it('refuses a non-finite numeric amount', () => {
      expectCode(
        () =>
          service.validateAmount(Number.POSITIVE_INFINITY, XLM, CORRELATION_ID),
        AssetMatrixErrorCode.AMOUNT_INVALID,
      );
    });
  });

  describe('adversarial input', () => {
    it('rejects a lowercase asset code', () => {
      // The DB constraint is uppercase-only; reject before the write.
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'usdc',
            assetIssuer: MAINNET_USDC_ISSUER,
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.INVALID_INPUT,
      );
    });

    it('rejects an over-long asset code', () => {
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'A'.repeat(13),
            assetIssuer: MAINNET_USDC_ISSUER,
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.INVALID_INPUT,
      );
    });

    it('rejects an asset code with punctuation', () => {
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'US;DC',
            assetIssuer: MAINNET_USDC_ISSUER,
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.INVALID_INPUT,
      );
    });

    it('rejects a log-injection payload in the asset code', () => {
      expectCode(
        () =>
          service.resolveAsset({
            assetCode: 'XLM\nlevel=ERROR',
            network: PaymentNetwork.MAINNET,
            correlationId: CORRELATION_ID,
          }),
        AssetMatrixErrorCode.INVALID_INPUT,
      );
    });
  });
});

/**
 * Asserts the call is rejected with a specific stable error code, so a test
 * pins the code a client would branch on rather than just "it threw".
 */
function expectCode(fn: () => unknown, expected: AssetMatrixErrorCode): void {
  try {
    fn();
    throw new Error(`expected rejection with ${expected}`);
  } catch (err) {
    const code = (err as { response?: { code?: string } }).response?.code;
    expect(code).toBe(expected);
  }
}
