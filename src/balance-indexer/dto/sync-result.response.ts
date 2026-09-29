import { ApiProperty } from '@nestjs/swagger';
import { BalanceSyncStatus } from '../domain/balance.model';

export class SyncResultResponseDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Wallet ID that was synced',
  })
  walletId: string;

  @ApiProperty({
    example: 5,
    description: 'Number of balances that were updated',
  })
  balancesUpdated: number;

  @ApiProperty({
    example: 0,
    description: 'Number of balance mismatches detected',
  })
  mismatchesFound: number;

  @ApiProperty({
    example: 'SYNCED',
    enum: BalanceSyncStatus,
    description: 'Overall sync status',
  })
  syncStatus: BalanceSyncStatus;

  @ApiProperty({
    example: '2024-06-24T12:34:56.789Z',
    description: 'When the sync completed',
  })
  lastSyncedAt: Date;
}
