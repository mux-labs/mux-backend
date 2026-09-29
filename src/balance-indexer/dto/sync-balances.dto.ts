import { IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SyncBalancesDto {
  @ApiProperty({
    example: false,
    description: 'Force refresh of all balances from Stellar Horizon',
    required: false,
  })
  @IsBoolean({ message: 'forceRefresh must be a boolean' })
  @IsOptional()
  forceRefresh?: boolean = false;
}
