import { ApiProperty } from '@nestjs/swagger';
import { AssetType } from '../domain/balance.model';

export class ReconciliationResultResponseDto {
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
    description: 'Indexed balance from database',
  })
  indexedBalance: string;

  @ApiProperty({
    example: '1000.5000000',
    description: 'On-chain balance from Stellar Horizon',
  })
  onChainBalance: string;

  @ApiProperty({
    example: true,
    description: 'Whether indexed and on-chain balances match',
  })
  matches: boolean;

  @ApiProperty({
    example: '0.0000000',
    description: 'Difference between indexed and on-chain balance (shown only if mismatch)',
    nullable: true,
  })
  difference?: string;
}
