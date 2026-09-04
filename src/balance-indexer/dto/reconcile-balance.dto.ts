import { IsEnum, IsOptional, IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AssetType } from '../domain/balance.model';
import { IsStellarPublicKey } from '../../common/stellar/is-stellar-public-key.validator';

export class ReconcileBalanceDto {
  @ApiProperty({
    example: 'NATIVE',
    enum: AssetType,
    description: 'Asset type (NATIVE, CREDIT_ALPHANUM4, CREDIT_ALPHANUM12, LIQUIDITY_POOL_SHARES)',
  })
  @IsEnum(AssetType, { message: 'assetType must be one of: NATIVE, CREDIT_ALPHANUM4, CREDIT_ALPHANUM12, LIQUIDITY_POOL_SHARES' })
  @IsNotEmpty({ message: 'assetType is required' })
  assetType: AssetType;

  @ApiProperty({
    example: 'USD',
    description: 'Asset code (required if assetType is CREDIT_ALPHANUM4 or CREDIT_ALPHANUM12)',
    required: false,
  })
  @IsString({ message: 'assetCode must be a string' })
  @IsOptional()
  assetCode?: string;

  @ApiProperty({
    example: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
    description: 'Asset issuer account ID (required if assetType is CREDIT_ALPHANUM4 or CREDIT_ALPHANUM12)',
    required: false,
  })
  @IsOptional()
  @IsStellarPublicKey()
  assetIssuer?: string;
}
