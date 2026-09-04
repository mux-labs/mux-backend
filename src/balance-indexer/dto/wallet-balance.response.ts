import { ApiProperty } from '@nestjs/swagger';
import { AssetType, BalanceSyncStatus } from '../domain/balance.model';

export class WalletBalanceResponseDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Balance record ID',
  })
  id: string;

  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Wallet ID',
  })
  walletId: string;

  @ApiProperty({
    example: 'NATIVE',
    enum: AssetType,
    description: 'Asset type',
  })
  assetType: AssetType;

  @ApiProperty({
    example: 'USD',
    description: 'Asset code (null for NATIVE)',
    nullable: true,
  })
  assetCode?: string | null;

  @ApiProperty({
    example: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
    description: 'Asset issuer account ID (null for NATIVE)',
    nullable: true,
  })
  assetIssuer?: string | null;

  @ApiProperty({
    example: '1000.5000000',
    description: 'Current balance as decimal string',
  })
  balance: string;

  @ApiProperty({
    example: 'SYNCED',
    enum: BalanceSyncStatus,
    description: 'Sync status',
  })
  syncStatus: BalanceSyncStatus;

  @ApiProperty({
    example: '2024-06-24T12:34:56.789Z',
    description: 'Last synced timestamp',
    nullable: true,
  })
  lastSyncedAt?: Date | null;

  @ApiProperty({
    example: 47261234,
    description: 'Last synced ledger sequence',
    nullable: true,
  })
  lastSyncedLedger?: number | null;

  @ApiProperty({
    example: '2024-06-24T11:30:00.000Z',
    description: 'Last reconciled timestamp',
    nullable: true,
  })
  lastReconciledAt?: Date | null;

  @ApiProperty({
    example: 2,
    description: 'Number of reconciliation attempts',
  })
  reconciliationAttempts: number;

  @ApiProperty({
    example: '1000.5000000',
    description: 'On-chain balance (from Stellar)',
    nullable: true,
  })
  onChainBalance?: string | null;

  @ApiProperty({
    example: '2024-06-24T12:00:00.000Z',
    description: 'When a balance mismatch was detected',
    nullable: true,
  })
  mismatchDetectedAt?: Date | null;

  @ApiProperty({
    example: '2024-06-24T10:00:00.000Z',
    description: 'Record creation timestamp',
  })
  createdAt: Date;

  @ApiProperty({
    example: '2024-06-24T12:34:56.789Z',
    description: 'Record update timestamp',
  })
  updatedAt: Date;
}
