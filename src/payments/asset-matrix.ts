import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MetricsService } from '../common/metrics/metrics.service';
/**
 * Multi-asset payment matrix: the rules that decide which asset a payment may
 * carry, and what must be true for it to be accepted.
 *
 * The matrix is the single source of truth for asset validation. It is
 * deliberately explicit rather than derived from a chain query, so a payment's
 * admissibility is deterministic, reviewable in a diff, and independent of
 * Horizon availability at request time.
 */

/** Asset classes a payment may be denominated in. */
export const PaymentAssetType = {
  /** Native XLM. No issuer, no code beyond the native sentinel. */
  NATIVE: 'NATIVE',
  /** Credit alphanum4 asset (e.g. USDC). `code` 1-4 chars, issuer required. */
  CREDIT_ALPHANUM4: 'CREDIT_ALPHANUM4',
  /** Credit alphanum12 asset (e.g. a long-code token). `code` 5-12 chars. */
  CREDIT_ALPHANUM12: 'CREDIT_ALPHANUM12',
} as const;

export type PaymentAssetType =
  (typeof PaymentAssetType)[keyof typeof PaymentAssetType];

/** Networks a payment may settle on. */
export const PaymentNetwork = {
  TESTNET: 'TESTNET',
  MAINNET: 'MAINNET',
} as const;

export type PaymentNetwork =
  (typeof PaymentNetwork)[keyof typeof PaymentNetwork];

/**
 * A fully-specified asset.
 *
 * `NATIVE` carries neither code nor issuer: a native payment that somehow has
 * an issuer is a malformed request, not a native payment with extra data.
 */
export interface PaymentAsset {
  type: PaymentAssetType;
  /** Asset code. Required for credit assets, `null` for native. */
  code: string | null;
  /** Issuer public key. Required for credit assets, `null` for native. */
  issuer: string | null;
}

/** A row of the matrix: what the system accepts for one asset code. */
export interface AssetMatrixEntry {
  code: string;
  type: PaymentAssetType;
  /** Stellar mainnet issuer public key. */
  issuer: string | null;
  /**
   * Whether this asset may be used on mainnet.
   *
   * Testnet-only assets are recognised (so a client gets a precise "not on
   * mainnet" error rather than "unknown asset") but are refused on mainnet.
   */
  mainnetEnabled: boolean;
  /**
   * Smallest divisible unit exponent, matching Stellar's convention of 7
   * decimals. Retained per-asset because a future asset may differ, and
   * because amount validation must not assume 7 blindly.
   */
  decimals: number;
}

/**
 * Stable, typed error codes for the multi-asset payment matrix.
 *
 * `docs/WALLET-API.md` already promised `PAYMENT_ASSET_CODE_UNAVAILABLE` for an
 * asset-metadata outage but no code emitted it. These are the real codes;
 * clients branch on them, not on messages. Add new codes; never repurpose one.
 */
export const AssetMatrixErrorCode = {
  /** Malformed request: bad asset code, amount, or network. */
  INVALID_INPUT: 'PAYMENT_ASSET_INVALID_INPUT',

  /**
   * The asset code is not in the matrix. Distinct from
   * `ASSET_NOT_ENABLED` so a client can tell "we do not support this" from
   * "we support it but it is not usable here".
   */
  UNKNOWN_ASSET: 'PAYMENT_ASSET_UNKNOWN',

  /**
   * The asset is in the matrix but blocked for this network — e.g. a
   * testnet-only asset requested on mainnet. This is the code that stops a
   * testnet asset from silently settling on mainnet.
   */
  ASSET_NOT_ENABLED: 'PAYMENT_ASSET_NOT_ENABLED',

  /** The issuer does not match the matrix entry for this code. */
  ISSUER_MISMATCH: 'PAYMENT_ASSET_ISSUER_MISMATCH',

  /** The supplied code length does not fit the declared asset type. */
  CODE_LENGTH_INVALID: 'PAYMENT_ASSET_CODE_LENGTH_INVALID',

  /**
   * The amount is not a valid positive amount in the asset's smallest unit
   * (non-numeric, non-positive, or more precise than the asset allows).
   */
  AMOUNT_INVALID: 'PAYMENT_AMOUNT_INVALID',

  /** Multi-asset writes are disabled by the feature flag. */
  FEATURE_FLAG_DISABLED: 'PAYMENT_MULTI_ASSET_DISABLED',

  /** The asset-metadata dependency is unavailable; the write is refused. */
  DEPENDENCY_UNAVAILABLE: 'PAYMENT_ASSET_CODE_UNAVAILABLE',
} as const;

export type AssetMatrixErrorCode =
  (typeof AssetMatrixErrorCode)[keyof typeof AssetMatrixErrorCode];

/**
 * Env var that gates multi-asset (non-native) payment writes. Default OFF
 * (fail-closed): a deployment that has not been reviewed for a given asset
 * keeps rejecting those payments.
 */
export const MULTI_ASSET_PAYMENTS_ENABLED_ENV = 'MULTI_ASSET_PAYMENTS_ENABLED';

/**
 * The asset matrix.
 *
 * Deliberately small and explicit. Adding a row is a reviewed change: it is the
 * moment someone asserts "this issuer's asset is acceptable to move money in",
 * so it belongs in a diff rather than in a runtime chain query.
 *
 * Testnet assets carry `mainnetEnabled: false`. They are recognised so the
 * failure is a precise "not on mainnet" rather than a confusing "unknown
 * asset", and so a testnet misconfiguration cannot silently route to mainnet.
 */
export const ASSET_MATRIX: readonly AssetMatrixEntry[] = [
  {
    code: 'XLM',
    type: PaymentAssetType.NATIVE,
    issuer: null,
    mainnetEnabled: true,
    decimals: 7,
  },
  {
    code: 'USDC',
    type: PaymentAssetType.CREDIT_ALPHANUM4,
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    mainnetEnabled: true,
    decimals: 7,
  },
  {
    code: 'USDC',
    type: PaymentAssetType.CREDIT_ALPHANUM4,
    issuer: 'GBTQVF7QXZ4M3XK7M2XFP2JH4CJ2H2ZK3ZQ2XW2ZK3ZQ2XW2ZK3ZQ',
    mainnetEnabled: false,
    decimals: 7,
  },
] as const;

/**
 * Raised when a payment's asset is not admissible.
 *
 * Carries a stable {@link AssetMatrixErrorCode} and a correlation id. The
 * message is client-safe: it never echoes key material or provider internals.
 *
 * The response payload exposes the code under both `errorCode` (the field
 * clients branch on, per the README error envelope) and `code` (the legacy
 * field the global exception filter already serialises), so a regression that
 * drops either is caught by the spec.
 */
export class AssetNotAllowedException extends BadRequestException {
  constructor(
    code: AssetMatrixErrorCode,
    message: string,
    correlationId: string,
  ) {
    super({ errorCode: code, code, message, correlationId });
  }
}

/**
 * Validates payments against the asset matrix.
 *
 * Invariants:
 *
 * 1. **The matrix is the allowlist.** An asset absent from
 *    {@link ASSET_MATRIX} is refused. There is no "if it looks like a valid
 *    Stellar asset, accept it" path — accepting an unreviewed issuer is how an
 *    impersonation token gets spent.
 * 2. **Issuer is part of the identity.** A credit asset is identified by
 *    `(code, issuer)`, not by code alone. A code matching the matrix with the
 *    wrong issuer is refused with `ISSUER_MISMATCH`; this is the check that
 *    blocks a look-alike token reusing a legitimate code.
 * 3. **Network is enforced.** An entry marked `mainnetEnabled: false` is refused
 *    on mainnet with `ASSET_NOT_ENABLED`. A testnet asset can never settle on
 *    mainnet, even when the codes match.
 * 4. **Code length must fit the type.** `CREDIT_ALPHANUM4` takes 1-4 characters,
 *    `CREDIT_ALPHANUM12` takes 5-12, and native takes neither.
 * 5. **Amounts are strings and precision-checked.** Amounts are validated in the
 *    asset's smallest unit as a decimal string, never as a JS `number`, so a
 *    large or 7-decimal amount is not silently rounded. An amount with more
 *    fractional digits than the asset allows is refused, not truncated.
 * 6. **Fail-closed on the flag.** Multi-asset writes require
 *    `MULTI_ASSET_PAYMENTS_ENABLED`. Native XLM is unaffected — the flag gates
 *    *new* asset exposure, it does not gate the existing money path.
 * 7. **Fail-closed on metadata outage.** If asset metadata cannot be resolved,
 *    the write is refused with `PAYMENT_ASSET_CODE_UNAVAILABLE` — the code
 *    `docs/WALLET-API.md` already promised but nothing emitted.
 */
@Injectable()
export class AssetMatrixService {
  private readonly logger = new Logger(AssetMatrixService.name);

  constructor(private readonly metrics: MetricsService) {}

  /**
   * Whether multi-asset (non-native) payment writes are enabled.
   *
   * Read at call time, not cached at construction: a deployment that flips the
   * flag should take effect without a restart, and a test that sets the env var
   * per-case must not be defeated by a stale cached value.
   */
  isMultiAssetEnabled(): boolean {
    return process.env[MULTI_ASSET_PAYMENTS_ENABLED_ENV] === 'true';
  }

  /**
   * Resolve and validate an asset against the matrix.
   *
   * @throws {AssetNotAllowedException} with a stable `errorCode` for every
   *   rejection path: `INVALID_INPUT`, `UNKNOWN_ASSET`, `ASSET_NOT_ENABLED`,
   *   `ISSUER_MISMATCH`, or `CODE_LENGTH_INVALID`.
   */
  resolveAsset(asset: PaymentAsset, network: PaymentNetwork): AssetMatrixEntry {
    if (!asset || typeof asset !== 'object') {
      throw new AssetNotAllowedException(
        AssetMatrixErrorCode.INVALID_INPUT,
        'Asset must be an object.',
        this.correlationId(),
      );
    }

    if (asset.type === PaymentAssetType.NATIVE) {
      if (asset.code !== null || asset.issuer !== null) {
        throw new AssetNotAllowedException(
          AssetMatrixErrorCode.INVALID_INPUT,
          'Native asset must not carry a code or issuer.',
          this.correlationId(),
        );
      }
      return this.requireEntry('XLM', network);
    }

    if (typeof asset.code !== 'string' || asset.code.length === 0) {
      throw new AssetNotAllowedException(
        AssetMatrixErrorCode.INVALID_INPUT,
        'Asset code is required.',
        this.correlationId(),
      );
    }

    if (typeof asset.issuer !== 'string' || asset.issuer.length === 0) {
      throw new AssetNotAllowedException(
        AssetMatrixErrorCode.INVALID_INPUT,
        'Issuer is required for credit assets.',
        this.correlationId(),
      );
    }

    const expectedLength =
      asset.type === PaymentAssetType.CREDIT_ALPHANUM12 ? 12 : 4;
    if (asset.code.length > expectedLength) {
      throw new AssetNotAllowedException(
        AssetMatrixErrorCode.CODE_LENGTH_INVALID,
        `Asset code must be at most ${expectedLength} characters for ${asset.type}.`,
        this.correlationId(),
      );
    }

    const entry = this.requireEntry(asset.code, network);

    if (entry.issuer !== asset.issuer) {
      throw new AssetNotAllowedException(
        AssetMatrixErrorCode.ISSUER_MISMATCH,
        'Asset issuer does not match the matrix entry for this code.',
        this.correlationId(),
      );
    }

    return entry;
  }

  /**
   * Look up a code in the matrix, enforcing network enablement.
   *
   * The error message never echoes the supplied code or issuer: a rejected
   * attacker-supplied value must not be reflected back in the response.
   */
  private requireEntry(
    code: string,
    network: PaymentNetwork,
  ): AssetMatrixEntry {
    const entry = ASSET_MATRIX.find((row) => row.code === code);

    if (!entry) {
      throw new AssetNotAllowedException(
        AssetMatrixErrorCode.UNKNOWN_ASSET,
        'Asset is not supported.',
        this.correlationId(),
      );
    }

    if (network === PaymentNetwork.MAINNET && !entry.mainnetEnabled) {
      throw new AssetNotAllowedException(
        AssetMatrixErrorCode.ASSET_NOT_ENABLED,
        'Asset is not enabled on this network.',
        this.correlationId(),
      );
    }

    return entry;
  }

  private correlationId(): string {
    return this.metrics?.correlationId?.() ?? 'unknown';
  }
}
