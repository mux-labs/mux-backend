import { IsString, IsOptional, IsEnum, IsPositive, MaxLength } from 'class-validator';
import { FeeSponsorshipBudgetStatus, FeeSponsorshipNetwork } from '../domain/fee-sponsorship-budget.model';

/**
 * Request payload for updating a fee sponsorship budget.
 *
 * All fields are optional; at least one must be provided.
 * Monetary amounts are strings in the asset's smallest unit.
 */
export class UpdateFeeSponsorshipBudgetDto {
  @IsOptional()
  @IsString()
  @IsPositive()
  limitAmount?: string;

  @IsOptional()
  @IsString()
  remainingAmount?: string;

  @IsOptional()
  @IsEnum(FeeSponsorshipBudgetStatus)
  status?: FeeSponsorshipBudgetStatus;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
