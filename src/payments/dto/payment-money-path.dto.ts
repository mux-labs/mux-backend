import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { PaymentNetwork } from '../payment-money-path.model';

/**
 * Request body for `POST /v1/payments`.
 *
 * Validation is deliberately strict (whitelist + charset bounds): an
 * adversarial body is rejected before the money path can touch a store or the
 * network. `dryRun` may also be requested with the `X-Dry-Run: true` header
 * and the idempotency key with the `Idempotency-Key` header, per
 * `docs/PAYMENT-DRY-RUN.md`.
 */
export class PaymentMoneyPathDto {
  @ApiProperty({ description: 'Wallet to debit.', example: 'wal_sender' })
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  walletId!: string;

  @ApiProperty({ description: 'Wallet to credit.', example: 'wal_receiver' })
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  receiverWalletId!: string;

  @ApiProperty({
    description: 'Positive decimal amount, at most 7 fractional digits.',
    example: '25.5',
  })
  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/)
  amount!: string;

  @ApiPropertyOptional({ description: 'Stellar asset code.', example: 'XLM' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{1,12}$/)
  assetCode?: string;

  @ApiPropertyOptional({
    description: 'Target network. Falls back to the configured network.',
    enum: PaymentNetwork,
  })
  @IsOptional()
  @IsEnum(PaymentNetwork)
  network?: PaymentNetwork;

  @ApiPropertyOptional({
    description: 'Validate and simulate without submitting anything.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({
    description: 'Idempotency key. Required for every payment write.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey?: string;
}
