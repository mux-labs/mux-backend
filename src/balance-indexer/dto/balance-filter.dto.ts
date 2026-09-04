import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AssetType } from '../domain/balance.model';
import { IsStellarPublicKey } from '../../common/stellar/is-stellar-public-key.validator';

export class BalanceFilterDto {
  @ApiProperty({
    example: 'NATIVE',
    enum: AssetType,
    description: 'Filter by asset type',
    required: false,
  })
  @IsEnum(AssetType, { message: 'assetType must be one of: NATIVE, CREDIT_ALPHANUM4, CREDIT_ALPHANUM12, LIQUIDITY_POOL_SHARES' })
  @IsOptional()
  assetType?: AssetType;

  @ApiProperty({
    example: 'USD',
    description: 'Filter by asset code',
    required: false,
  })
  @IsString({ message: 'assetCode must be a string' })
  @IsOptional()
  assetCode?: string;

  @ApiProperty({
    example: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
    description: 'Filter by asset issuer',
    required: false,
  })
  @IsOptional()
  @IsStellarPublicKey()
  assetIssuer?: string;
}
