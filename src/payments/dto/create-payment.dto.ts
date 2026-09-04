import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsInt,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePaymentDto {
  /** Sender wallet UUID — validated to exist and be ACTIVE before payment is created. */
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Sender wallet UUID - must exist and be ACTIVE',
  })
  @IsString({ message: 'walletId must be a string' })
  @IsNotEmpty({ message: 'walletId is required' })
  walletId: string;

  /** Receiver wallet UUID — validated to exist before payment is created. */
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174001',
    description: 'Receiver wallet UUID - must exist',
  })
  @IsString({ message: 'receiverWalletId must be a string' })
  @IsNotEmpty({ message: 'receiverWalletId is required' })
  receiverWalletId: string;

  @ApiProperty({
    example: 100.5,
    description:
      'Payment amount - must be positive with max 2 decimal places (e.g., 100.50)',
  })
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'amount must be a number with maximum 2 decimal places' },
  )
  @IsPositive({ message: 'amount must be positive' })
  amount: number;

  @ApiProperty({
    example: 'USD',
    description: 'Currency code',
  })
  @IsString({ message: 'currency must be a string' })
  @IsNotEmpty({ message: 'currency is required' })
  currency: string;

  @ApiProperty({
    example: 'USD',
    description: 'Asset code (ISO 4217 or custom identifier) - optional',
    required: false,
  })
  @IsString({ message: 'assetCode must be a string' })
  @IsOptional()
  assetCode?: string;

  @ApiProperty({
    example: 'Payment for services',
    description: 'Optional payment description',
    required: false,
  })
  @IsString({ message: 'description must be a string' })
  @IsOptional()
  description?: string;

  /** Legacy sender ID (LegacyUser.id) — required for payment record FK. */
  @ApiProperty({
    example: 1,
    description: 'Legacy sender ID (LegacyUser.id)',
  })
  @IsOptional()
  @IsInt({ message: 'fromId must be an integer' })
  @IsNotEmpty({ message: 'fromId is required' })
  @Min(1, { message: 'fromId must be greater than 0' })
  fromId?: number;

  /** Legacy receiver ID (LegacyUser.id) — required for payment record FK. */
  @ApiProperty({
    example: 2,
    description: 'Legacy receiver ID (LegacyUser.id)',
  })
  @IsOptional()
  @IsInt({ message: 'toId must be an integer' })
  @IsNotEmpty({ message: 'toId is required' })
  @Min(1, { message: 'toId must be greater than 0' })
  toId?: number;

  /** Client-supplied idempotency key. Replaying the same key returns the original payment instead of creating a duplicate. */
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-4789-a012-3456789abcde',
    description:
      'Optional client-supplied idempotency key. Reusing the same key returns the original payment instead of creating a duplicate.',
    required: false,
  })
  @IsString({ message: 'idempotencyKey must be a string' })
  @IsOptional()
  idempotencyKey?: string;
}
