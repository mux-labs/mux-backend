import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  IsObject,
  MinLength,
} from 'class-validator';

/**
 * DTO for creating an idempotent settlement.
 *
 * The `tradeId` serves as the idempotency key: if a settlement with the same
 * `tradeId` has already been processed, the existing result is returned and no
 * duplicate settlement is created.
 */
export class CreateSettlementDto {
  /**
   * Client-supplied trade identifier for idempotent settlement.
   * Must be unique — duplicate submissions with the same tradeId return the
   * original settlement result without creating a duplicate.
   */
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  tradeId: string;

  /**
   * The sender wallet UUID from which funds are settled.
   */
  @IsUUID()
  senderWalletId: string;

  /**
   * The receiver wallet UUID to which funds are settled.
   */
  @IsUUID()
  receiverWalletId: string;

  /**
   * Settlement amount as a decimal string (e.g. "10.50").
   */
  @IsString()
  @IsNotEmpty()
  amount: string;

  /**
   * Optional metadata for audit and tracking purposes.
   */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}
