import { IsNumber, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetLimitsDto {
  @ApiProperty({
    example: 5000,
    description: 'Daily transaction limit amount - must be positive',
  })
  @IsNumber({}, { message: 'dailyLimit must be a number' })
  @IsPositive({ message: 'dailyLimit must be positive' })
  dailyLimit: number;

  @ApiProperty({
    example: 1000,
    description: 'Per-transaction limit amount - must be positive',
  })
  @IsNumber({}, { message: 'perTransactionLimit must be a number' })
  @IsPositive({ message: 'perTransactionLimit must be positive' })
  perTransactionLimit: number;
}
