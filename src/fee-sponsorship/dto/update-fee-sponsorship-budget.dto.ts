import { IsString, IsOptional, IsEnum, MaxLength } from 'class-validator';
import { FeeSponsorshipBudgetStatus, FeeSponsorshipNetwork } from '../domain/fee-sponsorship-budget.model';
import { IsPositiveStroopsString } from './is-positive-stroops-string.decorator';

/**
 * Request payload for updating a fee sponsorship budget.
 *
 * All fields are optional; at least one must be provided.
 * Monetary amounts are strings in the asset's smallest unit.
 */
export class UpdateFeeSponsorshipBudgetDto {
  @IsOptional()
  @IsPositiveStroopsString()
  limitAmount?: string;

  @IsOptional()
  @IsPositiveStroopsString()
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
