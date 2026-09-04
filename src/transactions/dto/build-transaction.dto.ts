import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class BuildTransactionDto {
  /** Stellar public key of the source account */
  @ApiProperty({
    description: 'Stellar public key of the source account',
    example: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
  })
  @IsString()
  @IsNotEmpty()
  sourcePublicKey: string;

  /** Stellar public key of the destination account */
  @ApiProperty({
    description: 'Stellar public key of the destination account',
    example: 'GDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
  })
  @IsString()
  @IsNotEmpty()
  destinationPublicKey: string;

  /** Amount to send (string for precision, e.g. "10.5000000") */
  @ApiProperty({
    description: 'Amount to send, as a decimal string',
    example: '10.5',
  })
  @IsString()
  @IsNotEmpty()
  amount: string;

  /**
   * Asset to send.
   * Use "native" for XLM, or provide code + issuer for a custom asset.
   */
  @ApiProperty({
    description: 'Asset code to send. Use "native" for XLM.',
    example: 'native',
  })
  @IsString()
  @IsNotEmpty()
  assetCode: string; // "native" | "USDC" | etc.

  @ApiPropertyOptional({
    description: 'Asset issuer public key. Required when assetCode is not "native".',
  })
  @IsOptional()
  @IsString()
  assetIssuer?: string;

  /** Optional memo text (max 28 bytes) */
  @ApiPropertyOptional({ description: 'Optional memo text (max 28 bytes)' })
  @IsOptional()
  @IsString()
  memo?: string;

  /** Network: "TESTNET" | "MAINNET" */
  @ApiProperty({
    description: 'Stellar network to build the transaction for',
    enum: ['TESTNET', 'MAINNET'],
    example: 'TESTNET',
  })
  @IsIn(['TESTNET', 'MAINNET'])
  network: 'TESTNET' | 'MAINNET';
}

export class BuildTransactionResponseDto {
  /** Base64-encoded XDR of the unsigned transaction envelope */
  @ApiProperty({ description: 'Base64-encoded XDR of the unsigned transaction envelope' })
  xdr: string;

  /** Source account sequence number used */
  @ApiProperty({ description: 'Source account sequence number used' })
  sequence: string;

  /** Network passphrase used */
  @ApiProperty({ description: 'Network passphrase used' })
  networkPassphrase: string;
}
