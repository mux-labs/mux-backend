import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { WalletNetwork } from '../../wallets/domain/wallet.model';
import { HorizonHistoryResourceType } from '../domain/horizon-import.model';

export class ResumeImportDto {
  @ApiProperty({
    enum: WalletNetwork,
    required: false,
    default: WalletNetwork.TESTNET,
    description: 'Stellar network to import history from',
  })
  @IsEnum(WalletNetwork, { message: 'network must be MAINNET or TESTNET' })
  @IsOptional()
  network?: WalletNetwork;

  @ApiProperty({
    enum: HorizonHistoryResourceType,
    required: false,
    default: HorizonHistoryResourceType.PAYMENTS,
    description: 'Horizon history resource stream to import',
  })
  @IsEnum(HorizonHistoryResourceType, {
    message: 'resourceType must be one of: payments, operations, transactions',
  })
  @IsOptional()
  resourceType?: HorizonHistoryResourceType;

  @ApiProperty({
    required: false,
    default: 200,
    minimum: 1,
    maximum: 200,
    description: 'Horizon page size for this resume call',
  })
  @Type(() => Number)
  @IsInt({ message: 'pageLimit must be an integer' })
  @Min(1, { message: 'pageLimit must be at least 1' })
  @Max(200, { message: 'pageLimit must be at most 200' })
  @IsOptional()
  pageLimit?: number;
}
