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
  });

  describe('error envelope', () => {
    it('reports UNKNOWN_ASSET with a 422 status and a branchable errorCode', () => {
      const err = captureError(() =>
        service.resolveAsset({
          assetCode: 'SCAM',
          assetIssuer: MAINNET_USDC_ISSUER,
          network: PaymentNetwork.MAINNET,
          correlationId: CORRELATION_ID,
        }),
      );

      expect(err.getStatus()).toBe(422);
      expectErrorEnvelope(err, AssetMatrixErrorCode.UNKNOWN_ASSET);
    });

    it('reports ISSUER_MISMATCH with a 422 status and a branchable errorCode', () => {
      const err = captureError(() =>
        service.resolveAsset({
          assetCode: 'USDC',
          assetIssuer:
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          network: PaymentNetwork.MAINNET,
          correlationId: CORRELATION_ID,
        }),
      );

      expect(err.getStatus()).toBe(422);
      expectErrorEnvelope(err, AssetMatrixErrorCode.ISSUER_MISMATCH);
    });

    it('reports INVALID_INPUT with a 422 status and a branchable errorCode', () => {
      const err = captureError(() =>
        service.resolveAsset({
          assetIssuer: MAINNET_USDC_ISSUER,
          network: PaymentNetwork.MAINNET,
          correlationId: CORRELATION_ID,
        }),
      );

      expect(err.getStatus()).toBe(422);
      expectErrorEnvelope(err, AssetMatrixErrorCode.INVALID_INPUT);
    });
  });
});

function captureError(fn: () => unknown): {
  getStatus: () => number;
  getResponse: () => unknown;
} {
  try {
    fn();
  } catch (err) {
    return err as { getStatus: () => number; getResponse: () => unknown };
  }
  throw new Error('expected rejection');
}

function expectErrorEnvelope(
  err: { getResponse: () => unknown },
  code: AssetMatrixErrorCode,
): void {
  const response = err.getResponse() as {
    errorCode?: string;
    message?: string;
  };

  expect(response.errorCode).toBe(code);
  expect(typeof response.message).toBe('string');
  expect(response.message?.length).toBeGreaterThan(0);
}

function expectCode(fn: () => unknown, code: AssetMatrixErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect((err as { response: { errorCode?: string } }).response.errorCode).toBe(
      code,
    );
    return;
  }
  throw new Error('expected rejection');
}
