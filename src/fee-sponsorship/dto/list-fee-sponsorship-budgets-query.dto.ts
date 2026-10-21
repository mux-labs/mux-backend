import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { FeeSponsorshipNetwork } from '../domain/fee-sponsorship-budget.model';

/** Page size used when `limit` is not provided. */
export const FEE_SPONSORSHIP_LIST_DEFAULT_LIMIT = 20;

/** Hard upper bound on `limit`; larger values are rejected with 400. */
export const FEE_SPONSORSHIP_LIST_MAX_LIMIT = 100;

/**
 * Query parameters for listing fee sponsorship budgets.
 *
 * Invariants:
 * - `walletId` is required and must be non-empty.
 * - `network`, when present, must be a known FeeSponsorshipNetwork.
 * - `limit` is an integer in [1, FEE_SPONSORSHIP_LIST_MAX_LIMIT].
 * - `cursor` is the `id` of the last budget on the previous page.
 */
export class ListFeeSponsorshipBudgetsQueryDto {
  @IsString()
  @IsNotEmpty()
  walletId!: string;

  @IsOptional()
  @IsEnum(FeeSponsorshipNetwork)
  network?: FeeSponsorshipNetwork;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(FEE_SPONSORSHIP_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cursor?: string;
}
