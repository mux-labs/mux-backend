import { IsNumber, IsPositive, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateLimitsDto {
  @ApiProperty({
    example: 5000,
    description: 'Daily transaction limit amount - must be positive',
    required: false,
  })
  @IsOptional()
  @IsNumber({}, { message: 'dailyLimit must be a number' })
  @IsPositive({ message: 'dailyLimit must be positive' })
  dailyLimit?: number;

  @ApiProperty({
    example: 1000,
    description: 'Per-transaction limit amount - must be positive',
    required: false,
  })
  @IsOptional()
  @IsNumber({}, { message: 'perTransactionLimit must be a number' })
  @IsPositive({ message: 'perTransactionLimit must be positive' })
  perTransactionLimit?: number;
}
