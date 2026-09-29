import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { AssetType } from '../domain/balance.model';

export class GetBalanceQueryDto {
  @ApiProperty({
    example: 'NATIVE',
    enum: AssetType,
    description: 'Asset type (NATIVE, CREDIT_ALPHANUM4, CREDIT_ALPHANUM12, LIQUIDITY_POOL_SHARES)',
    required: false,
  })
  @IsEnum(AssetType, { message: 'assetType must be one of: NATIVE, CREDIT_ALPHANUM4, CREDIT_ALPHANUM12, LIQUIDITY_POOL_SHARES' })
  @IsOptional()
  assetType?: AssetType;

  @ApiProperty({
    example: 'USD',
    description: 'Asset code (required if assetType is CREDIT_ALPHANUM4 or CREDIT_ALPHANUM12)',
    required: false,
  })
  @IsString({ message: 'assetCode must be a string' })
  @IsOptional()
  assetCode?: string;

  @ApiProperty({
    example: 'GCIZXUUIINYG2TWZVBU5CRZHXDUWTLF6AUAEO3YRXTX3YKY7SU6JLRAL',
    description: 'Asset issuer account ID (required if assetType is CREDIT_ALPHANUM4 or CREDIT_ALPHANUM12)',
    required: false,
  })
  @IsString({ message: 'assetIssuer must be a string' })
  @IsOptional()
  assetIssuer?: string;
}
