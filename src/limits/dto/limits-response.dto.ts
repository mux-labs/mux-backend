import { ApiProperty } from '@nestjs/swagger';

export class LimitsResponseDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Wallet ID (UUID)',
  })
  walletId: string;

  @ApiProperty({
    example: 5000,
    description: 'Daily transaction limit amount',
  })
  dailyLimit: number;

  @ApiProperty({
    example: 1000,
    description: 'Per-transaction limit amount',
  })
  perTransactionLimit: number;

  @ApiProperty({
    example: 2500,
    description:
      'Remaining daily limit (dailyLimit - sum of transactions today). Only present when dailyLimit > 0.',
    required: false,
  })
  remainingDailyLimit?: number;
}
