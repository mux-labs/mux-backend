import { IsString, IsNotEmpty, IsEnum, IsOptional, IsPositive, MaxLength } from 'class-validator';
import { FeeSponsorshipBudgetStatus, FeeSponsorshipNetwork } from '../domain/fee-sponsorship-budget.model';

/**
 * Request payload for creating a fee sponsorship budget.
 *
 * Invariants:
 * - `limitAmount` must be a positive numeric string (stroops or smallest unit).
 * - `walletId` and `sponsorId` are required.
 * - `network` defaults to TESTNET if not provided.
 * - `assetCode` and `assetIssuer` are optional (null = native XLM).
 */
export class CreateFeeSponsorshipBudgetDto {
  @IsString()
  @IsNotEmpty()
  walletId!: string;

  @IsString()
  @IsNotEmpty()
  sponsorId!: string;

  @IsString()
  @IsNotEmpty()
  @IsPositive()
  limitAmount!: string;

  @IsOptional()
  @IsString()
  assetCode?: string;

  @IsOptional()
  @IsString()
  assetIssuer?: string;

  @IsOptional()
  @IsEnum(FeeSponsorshipNetwork)
  network?: FeeSponsorshipNetwork;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
