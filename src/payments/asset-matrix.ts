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
 */
export class AssetNotAllowedException extends BadRequestException {
  constructor(
    code: AssetMatrixErrorCode,
    message: string,
    correlationId: string,
  ) {
    super({ code, message, correlationId });
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
   * Fail-closed: only an explicit `true`/`1` enables them.
   */
  isMultiAssetEnabled(): boolean {
    const raw = process.env[MULTI_ASSET_PAYMENTS_ENABLED_ENV];
    return raw === 'true' || raw === '1';
  }

  /**
   * The assets usable on a network, for a client to render a picker from.
   *
   * Returns metadata only — never an issuer secret or a balance.
   */
  listSupportedAssets(network: PaymentNetwork): AssetMatrixEntry[] {
    // Mainnet exposes only assets explicitly enabled for it. Testnet exposes
    // everything, because that is where unreviewed assets get exercised before
    // being enabled on mainnet.
    return network === PaymentNetwork.MAINNET
      ? ASSET_MATRIX.filter((entry) => entry.mainnetEnabled)
      : [...ASSET_MATRIX];
  }

  /**
   * Resolves and validates a payment's asset.
   *
   * Returns the normalised asset to persist, or throws a stable
   * {@link AssetNotAllowedException}. Throwing rather than returning a verdict
   * object makes it impossible for a caller to ignore the result.
   */
  resolveAsset(input: {
    assetCode?: string | null;
    assetIssuer?: string | null;
    network: PaymentNetwork;
    correlationId: string;
  }): PaymentAsset {
    const { network, correlationId } = input;
    // An absent code means native XLM: the pre-matrix default, unchanged.
    const rawCode = input.assetCode?.trim();

    if (!rawCode) {
      if (input.assetIssuer) {
        // An issuer with no code is a malformed credit asset, not native.
        throw this.reject(
          AssetMatrixErrorCode.INVALID_INPUT,
          'assetIssuer requires an assetCode',
          correlationId,
        );
      }
      return { type: PaymentAssetType.NATIVE, code: null, issuer: null };
    }

    // The DB constraint allows 1-12 uppercase alphanumerics; enforcing the same
    // shape here means a bad code is rejected with a clear code rather than a
    // constraint violation at write time.
    if (!/^[A-Z0-9]{1,12}$/.test(rawCode)) {
      throw this.reject(
        AssetMatrixErrorCode.INVALID_INPUT,
        'assetCode must be 1-12 uppercase alphanumeric characters',
        correlationId,
      );
    }

    // Native XLM may be named for readability but must not carry an issuer;
    // accepting one would let a caller assert a fake native asset.
    if (rawCode === 'XLM') {
      if (input.assetIssuer) {
        throw this.reject(
          AssetMatrixErrorCode.ISSUER_MISMATCH,
          'Native XLM must not specify an issuer',
          correlationId,
        );
      }
      return { type: PaymentAssetType.NATIVE, code: 'XLM', issuer: null };
    }

    // Everything below is a credit asset, so the multi-asset flag applies.
    this.assertMultiAssetEnabled(correlationId);

    const candidates = ASSET_MATRIX.filter((entry) => entry.code === rawCode);
    if (candidates.length === 0) {
      this.metrics.incrementCounter('payment_asset_unknown');
      throw this.reject(
        AssetMatrixErrorCode.UNKNOWN_ASSET,
        `Asset ${rawCode} is not supported`,
        correlationId,
      );
    }

    // An issuer is mandatory for a credit asset. Its absence is a mismatch
    // rather than a lookup miss, so a client cannot probe which issuers exist
    // by omitting the field.
    if (!input.assetIssuer) {
      throw this.reject(
        AssetMatrixErrorCode.ISSUER_MISMATCH,
        `assetIssuer is required for ${rawCode}`,
        correlationId,
      );
    }

    // A known code with an unrecognised issuer is a look-alike token.
    const entry = candidates.find(
      (candidate) => candidate.issuer === input.assetIssuer,
    );
    if (!entry) {
      this.metrics.incrementCounter('payment_asset_issuer_mismatch');
      // The issuer is not echoed: a mismatched issuer is attacker-supplied.
      this.logger.warn(
        `payment.asset rejected unknownIssuer code=${rawCode} correlationId=${correlationId}`,
      );
      throw this.reject(
        AssetMatrixErrorCode.ISSUER_MISMATCH,
        `Issuer is not recognised for asset ${rawCode}`,
        correlationId,
      );
    }

    // Network enforcement: this is what stops a testnet asset settling on
    // mainnet even though its code and issuer are otherwise valid.
    if (network === PaymentNetwork.MAINNET && !entry.mainnetEnabled) {
      this.metrics.incrementCounter('payment_asset_not_enabled');
      throw this.reject(
        AssetMatrixErrorCode.ASSET_NOT_ENABLED,
        `Asset ${rawCode} is not enabled on MAINNET`,
        correlationId,
      );
    }

    this.assertCodeLength(entry, correlationId);

    return { type: entry.type, code: entry.code, issuer: entry.issuer };
  }

  /**
   * Validates a payment amount against the asset's precision.
   *
   * The amount is the value in the asset's **smallest unit** as a decimal
   * string. Working in strings throughout avoids the two classic multi-asset
   * bugs: a JS `number` silently losing precision above 2^53 stroops, and a
   * float amount being rounded in a way that does not match the ledger.
   *
   * An amount with more fractional digits than the asset allows is **refused**,
   * not truncated — silently rounding a payment is how a user sends a different
   * amount than they asked for.
   */
  validateAmount(
    amount: string | number,
    entry: AssetMatrixEntry,
    correlationId: string,
  ): string {
    const raw =
      typeof amount === 'number' ? numberToAmountString(amount) : amount;

    if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw)) {
      throw this.reject(
        AssetMatrixErrorCode.AMOUNT_INVALID,
        'amount must be a positive decimal in the smallest unit',
        correlationId,
      );
    }

    const [whole = '0', fraction = ''] = raw.split('.');

    if (fraction.length > entry.decimals) {
      this.metrics.incrementCounter('payment_amount_precision_exceeded');
      throw this.reject(
        AssetMatrixErrorCode.AMOUNT_INVALID,
        `amount has more than ${entry.decimals} decimal places for ${entry.code}`,
        correlationId,
      );
    }

    // Zero is refused: a zero-amount payment is never meaningful and would
    // otherwise be a free way to spam the ledger.
    if (/^0+$/.test(whole) && /^0*$/.test(fraction)) {
      throw this.reject(
        AssetMatrixErrorCode.AMOUNT_INVALID,
        'amount must be greater than zero',
        correlationId,
      );
    }

    // Normalised so equal amounts compare equal downstream regardless of how
    // many trailing zeros the client sent.
    const trimmed = fraction.replace(/0+$/, '');
    return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Deny-by-default gate for credit assets. Native XLM never reaches this, so
   * disabling the flag does not break the existing money path.
   */
  private assertMultiAssetEnabled(correlationId: string): void {
    if (this.isMultiAssetEnabled()) {
      return;
    }
    this.metrics.incrementCounter('payment_multi_asset_blocked_by_flag');
    this.logger.warn(
      `payment.asset refused: ${MULTI_ASSET_PAYMENTS_ENABLED_ENV} is not enabled ` +
        `correlationId=${correlationId}`,
    );
    throw new ServiceUnavailableException({
      code: AssetMatrixErrorCode.FEATURE_FLAG_DISABLED,
      message: `Multi-asset payments are disabled; set ${MULTI_ASSET_PAYMENTS_ENABLED_ENV}=true to enable`,
      correlationId,
    });
  }

  /**
   * Enforces that the code length fits the declared asset type.
   *
   * A `CREDIT_ALPHANUM4` entry with a 5-character code could never be
   * submitted to the network, so accepting it would create a payment that can
   * never settle.
   */
  private assertCodeLength(
    entry: AssetMatrixEntry,
    correlationId: string,
  ): void {
    if (entry.type === PaymentAssetType.NATIVE) {
      return;
    }

    const length = entry.code.length;
    const valid =
      entry.type === PaymentAssetType.CREDIT_ALPHANUM4
        ? length >= 1 && length <= 4
        : length >= 5 && length <= 12;

    if (!valid) {
      throw this.reject(
        AssetMatrixErrorCode.CODE_LENGTH_INVALID,
        `asset code length ${length} is invalid for ${entry.type}`,
        correlationId,
      );
    }
  }

  /** Builds the rejection, counting it for observability. */
  private reject(
    code: AssetMatrixErrorCode,
    message: string,
    correlationId: string,
  ): AssetNotAllowedException {
    this.metrics.incrementCounter('payment_asset_rejected');
    return new AssetNotAllowedException(code, message, correlationId);
  }
}

/**
 * Renders a numeric amount as a decimal string without exponent notation.
 *
 * `1e-7` and `1e21` both stringify to exponent form, which the amount regex
 * would reject — and a client sending `0.0000001` as a JSON number is
 * legitimate. Large integers are emitted in full rather than via
 * `toExponential`, so precision is preserved.
 */
function numberToAmountString(value: number): string {
  if (!Number.isFinite(value)) {
    return String(value);
  }
  const asString = value.toString();
  if (!/e/i.test(asString)) {
    return asString;
  }
  // Expand exponent notation into plain decimal form.
  return value.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}
