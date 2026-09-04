import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
} from 'class-validator';

/**
 * Request body for invoking a Soroban smart contract method using a
 * Mux-custodied wallet as the invocation source account.
 */
export class SorobanInvokeDto {
  @ApiProperty({
    description: 'Mux wallet ID whose key signs the invocation transaction.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsString()
  @IsNotEmpty()
  walletId: string;

  @ApiProperty({
    description: 'Soroban contract ID (strkey, starts with C...).',
    example: 'CABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
  })
  @IsString()
  @IsNotEmpty()
  contractId: string;

  @ApiProperty({
    description: 'Contract method name to invoke.',
    example: 'transfer',
  })
  @IsString()
  @IsNotEmpty()
  method: string;

  @ApiPropertyOptional({
    description: 'Method arguments, converted to ScVal via nativeToScVal.',
    example: [],
  })
  @IsOptional()
  @IsArray()
  args?: unknown[];

  @ApiPropertyOptional({
    description: 'Stellar network to invoke on.',
    enum: ['TESTNET', 'MAINNET'],
    example: 'TESTNET',
  })
  @IsOptional()
  @IsIn(['TESTNET', 'MAINNET'])
  network?: 'TESTNET' | 'MAINNET';
}
