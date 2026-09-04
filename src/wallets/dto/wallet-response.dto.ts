import { ApiProperty } from '@nestjs/swagger';
import { WalletNetwork, WalletStatus } from '../domain/wallet.model';

export class WalletResponseDto {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Wallet unique identifier',
  })
  id: string;

  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174001',
    description: 'Owner user ID',
  })
  userId: string;

  @ApiProperty({
    example: 'GDQPVLQG2R....',
    description: 'Chain-agnostic public identifier',
  })
  publicKey: string;

  @ApiProperty({
    example: 'Savings wallet',
    description: 'Optional human-readable label for the wallet',
    nullable: true,
    required: false,
  })
  nickname?: string | null;

  @ApiProperty({
    enum: WalletNetwork,
    example: WalletNetwork.MAINNET,
    description: 'Network (MAINNET or TESTNET)',
  })
  network: WalletNetwork;

  @ApiProperty({
    enum: WalletStatus,
    example: WalletStatus.ACTIVE,
    description: 'Wallet status',
  })
  status: WalletStatus;

  @ApiProperty({
    example: 'Wallet activated successfully',
    description: 'Status change reason (if applicable)',
    nullable: true,
  })
  statusReason?: string | null;

  @ApiProperty({
    example: '2026-07-26T12:34:56Z',
    description: 'ISO 8601 timestamp when status last changed',
  })
  statusChangedAt: Date;

  @ApiProperty({
    example: null,
    description: 'ID of wallet this one was rotated from (if applicable)',
    nullable: true,
  })
  rotatedFromId?: string | null;

  @ApiProperty({
    example: 1,
    description: 'Encryption version (supports future crypto upgrades)',
  })
  encryptionVersion: number;

  @ApiProperty({
    example: 1,
    description: 'Secret version (supports key rotation)',
  })
  secretVersion: number;

  @ApiProperty({
    example: '2026-07-26T10:00:00Z',
    description: 'ISO 8601 timestamp when wallet was created',
  })
  createdAt: Date;

  @ApiProperty({
    example: '2026-07-26T12:34:56Z',
    description: 'ISO 8601 timestamp when wallet was last updated',
  })
  updatedAt: Date;
}
