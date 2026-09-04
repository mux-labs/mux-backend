import { ApiProperty } from '@nestjs/swagger';
import { RecoveryRequest } from '../entities/recovery.entity';

export class PaginatedRecoveryDto {
  @ApiProperty({ type: [RecoveryRequest], description: 'Array of recovery requests' })
  data: RecoveryRequest[];

  @ApiProperty({ description: 'Total number of matching records', example: 42 })
  total: number;

  @ApiProperty({ description: 'Maximum records returned in this page', example: 20 })
  limit: number;

  @ApiProperty({ description: 'Number of records skipped', example: 0 })
  offset: number;

  @ApiProperty({ description: 'Whether more records are available', example: true })
  hasMore: boolean;
}
