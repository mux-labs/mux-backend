import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreatePaymentDto {
  @ApiProperty({
    description: 'Legacy sender ID (LegacyUser.id) — required for payment record FK',
    example: 42,
  })
  @IsInt()
  fromId: number;

  @ApiProperty({
    description: 'Sender wallet UUID — used for wallet-scoped limit checks',
    example: '3f1c2b4a-5d6e-4f7a-8b9c-0d1e2f3a4b5c',
  })
  @IsUUID()
  walletId: string;

  @ApiPropertyOptional({
    description: 'Recipient wallet UUID',
    example: '9a8b7c6d-5e4f-3a2b-1c0d-9e8f7a6b5c4d',
  })
  @IsOptional()
  @IsUUID()
  toWalletId?: string;

  @ApiProperty({
    description: 'Payment amount',
    example: 100,
  })
  @IsNumber()
  @IsPositive()
  @Min(0.000001)
  amount: number;

  @ApiPropertyOptional({
    description: 'Currency code',
    example: 'USD',
  })
  @IsOptional()
  @IsString()
  currency?: string;
}
