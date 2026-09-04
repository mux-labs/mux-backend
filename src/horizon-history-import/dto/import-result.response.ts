import { ApiProperty } from '@nestjs/swagger';
import { WalletNetwork } from '../../wallets/domain/wallet.model';
import {
  HorizonHistoryResourceType,
  HorizonImportStatus,
} from '../domain/horizon-import.model';

export class ImportResultResponseDto {
  @ApiProperty({ example: 'GABC...XYZ', description: 'Stellar account public key' })
  accountId: string;

  @ApiProperty({ enum: WalletNetwork, example: WalletNetwork.TESTNET })
  network: WalletNetwork;

  @ApiProperty({
    enum: HorizonHistoryResourceType,
    example: HorizonHistoryResourceType.PAYMENTS,
  })
  resourceType: HorizonHistoryResourceType;

  @ApiProperty({
    example: '12345678901234-1',
    nullable: true,
    description: 'Horizon paging token the next resume call will start from',
  })
  cursor: string | null;

  @ApiProperty({
    example: 42,
    description: 'Cumulative records imported across all resumed runs',
  })
  recordsImported: number;

  @ApiProperty({
    example: 20,
    description: 'Records processed during this call',
  })
  recordsImportedThisRun: number;

  @ApiProperty({ enum: HorizonImportStatus, example: HorizonImportStatus.COMPLETED })
  status: HorizonImportStatus;
}
