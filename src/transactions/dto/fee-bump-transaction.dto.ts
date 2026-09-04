import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsIn } from 'class-validator';
import { IsStellarPublicKey } from '../../common/stellar/is-stellar-public-key.validator';

/**
 * Request body for the fee-bump submission endpoint.
 *
 * A fee-bump transaction wraps an already-signed inner transaction and re-signs
 * it with a fee-account so that a sponsoring account pays the network fee on
 * behalf of the original submitter.
 *
 * See: https://developers.stellar.org/docs/encyclopedia/fee-bump-transactions
 */
export class FeeBumpTransactionDto {
  /**
   * Base64-encoded XDR of the inner (already-signed) transaction envelope.
   * This is the original transaction that needs its fee bumped.
   */
  @ApiProperty({
    description:
      'Base64-encoded XDR of the inner signed transaction envelope.',
    example:
      'AAAAAgAAAABiZ3gQRv9n8WD/OQ2h6M6kl9d0m5fP6K3D...',
  })
  @IsString()
  @IsNotEmpty()
  innerTransactionXdr: string;

  /**
   * Stellar public key of the fee-source account (sponsor).
   * This account signs the fee-bump envelope and pays the network fee.
   */
  @ApiProperty({
    description:
      'Stellar public key of the fee-source (sponsor) account that will pay the fee.',
    example: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
  })
  @IsStellarPublicKey()
  feeSourcePublicKey: string;

  /**
   * Wallet ID of the fee-source account within Mux.
   * Used to look up the encrypted private key for signing the fee-bump envelope.
   */
  @ApiProperty({
    description:
      'Mux wallet ID of the fee-source account (used to retrieve the signing key).',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  feeSourceWalletId: string;

  /**
   * Internal Mux transaction ID of the original inner transaction.
   * Used to update the persisted status after the fee-bump submission.
   */
  @ApiPropertyOptional({
    description:
      'Internal Mux transaction ID of the original transaction (used to update status).',
    example: '550e8400-e29b-41d4-a716-446655440001',
  })
  @IsOptional()
  @IsString()
  transactionId?: string;

  /**
   * Network to submit to.
   */
  @ApiProperty({
    description: 'Stellar network to submit to.',
    enum: ['TESTNET', 'MAINNET'],
    example: 'TESTNET',
  })
  @IsIn(['TESTNET', 'MAINNET'])
  network: 'TESTNET' | 'MAINNET';
}

export class FeeBumpResultDto {
  @ApiProperty({ description: 'Stellar transaction hash of the fee-bump transaction.' })
  stellarHash: string;

  @ApiProperty({
    description: 'Submission result status.',
    enum: ['SUBMITTED', 'CONFIRMED', 'FAILED'],
  })
  status: string;

  @ApiPropertyOptional({ description: 'Internal Mux transaction ID (if provided).' })
  transactionId?: string;

  @ApiPropertyOptional({ description: 'Fee charged (in stroops).' })
  feeCharged?: string;
}
