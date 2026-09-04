import {
  IsString,
  IsNumber,
  IsPositive,
  IsEnum,
  IsOptional,
  IsBoolean,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LimitPeriod } from './create-limit.dto';

/**
 * DTO for setting a per-asset spending limit.
 * userId is taken from the route parameter, not the request body.
 */
export class SetSpendingLimitDto {
  @ApiProperty({
    example: 1000.12345678,
    description:
      'Per-transaction limit (max 8 decimal places) - must be positive',
  })
  @IsNumber(
    { maxDecimalPlaces: 8 },
    {
      message: 'perTransactionLimit must be a number with max 8 decimal places',
    },
  )
  @IsPositive({ message: 'perTransactionLimit must be positive' })
  perTransactionLimit: number;

  @ApiProperty({
    example: 10000.5,
    description:
      'Period limit amount (max 8 decimal places) - must be positive',
  })
  @IsNumber(
    { maxDecimalPlaces: 8 },
    { message: 'periodLimit must be a number with max 8 decimal places' },
  )
  @IsPositive({ message: 'periodLimit must be positive' })
  periodLimit: number;

  @ApiProperty({
    example: 'DAILY',
    enum: LimitPeriod,
    description: 'Limit period',
    required: false,
  })
  @IsEnum(LimitPeriod, {
    message: 'period must be one of: DAILY, WEEKLY, MONTHLY',
  })
  @IsOptional()
  period?: LimitPeriod;

  @ApiProperty({
    example: 'USD',
    description:
      'Asset code (max 12 characters); omit for all assets (e.g. native XLM)',
    required: false,
  })
  @IsString({ message: 'assetCode must be a string' })
  @MaxLength(12, { message: 'assetCode must not exceed 12 characters' })
  @IsOptional()
  assetCode?: string;

  @ApiProperty({
    example: true,
    description: 'Whether the limit is active',
    required: false,
  })
  @IsBoolean({ message: 'isActive must be a boolean' })
  @IsOptional()
  isActive?: boolean;
}
