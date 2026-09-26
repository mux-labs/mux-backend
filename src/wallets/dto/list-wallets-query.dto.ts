import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { WalletNetwork, WalletStatus } from '../domain/wallet.model';

/** Default page size when the caller does not supply `limit`. */
export const DEFAULT_WALLET_LIST_LIMIT = 20;

/** Hard ceiling on `limit`. A caller can never request an unbounded page. */
export const MAX_WALLET_LIST_LIMIT = 100;

/**
 * Parses the boolean-ish query params (`includeArchived`, `loadTestMode`).
 *
 * Only the literal string `true` enables them, so `?loadTestMode=1` or
 * `?loadTestMode=yes` does not silently opt a caller into a different code
 * path than the one the docs describe.
 */
const EXACT_TRUE = 'true';

/** Typed query for `GET /v1/wallets` ([#936]). */
export class ListWalletsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  userId?: string;

  /**
   * Validated against the closed `WalletNetwork` enum. Without this, an
   * arbitrary string reaches the database filter and a typo silently widens
   * the result set across testnet **and** mainnet instead of failing.
   */
  @IsOptional()
  @IsEnum(WalletNetwork)
  network?: WalletNetwork;

  @IsOptional()
  @IsEnum(WalletStatus)
  status?: WalletStatus;

  /** Include archived wallets (excluded by default). */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === EXACT_TRUE)
  includeArchived?: boolean;

  /**
   * `@Type(() => Number)` is required: query parameters arrive as strings and
   * the global pipe runs without `enableImplicitConversion`, so `@IsInt()`
   * alone would reject every real request. The validator then rejects
   * non-numeric input (`?limit=all`) instead of it silently becoming `NaN`.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_WALLET_LIST_LIMIT)
  limit?: number = DEFAULT_WALLET_LIST_LIMIT;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;

  /**
   * Synthetic data for local load testing. Refused with `403` in production by
   * the service; the flag itself is documented and gated, not free-form.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === EXACT_TRUE)
  loadTestMode?: boolean;
}
