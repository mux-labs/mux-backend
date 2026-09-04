import { IsEnum, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { LimitPeriod } from './create-limit.dto';
import { Type } from 'class-transformer';

export class LimitsFilterDto {
  @ApiProperty({
    example: 'DAILY',
    enum: LimitPeriod,
    description: 'Filter by limit period',
    required: false,
  })
  @IsEnum(LimitPeriod, { message: 'period must be one of: DAILY, WEEKLY, MONTHLY' })
  @IsOptional()
  period?: LimitPeriod;

  @ApiProperty({
    example: true,
    description: 'Filter by active status',
    required: false,
  })
  @IsBoolean({ message: 'isActive must be a boolean' })
  @IsOptional()
  @Type(() => Boolean)
  isActive?: boolean;
}
