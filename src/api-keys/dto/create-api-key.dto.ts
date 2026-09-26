import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Request body for `POST /v1/api-keys`.
 *
 * `network` is the key's scope (#943): omitted = all networks. A scoped key is
 * refused on any other network with `NETWORK_MISMATCH`.
 */
export class CreateApiKeyDto {
  @ApiProperty({ description: 'Human-readable label for the key' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  name: string;

  @ApiProperty({ description: 'Project the key belongs to' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  projectId: string;

  @ApiPropertyOptional({
    description:
      'ISO 8601 expiry. Omitted = the configured API_KEY_DEFAULT_EXPIRY_DAYS (0 = never expires).',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional({
    enum: ['MAINNET', 'TESTNET'],
    description: 'Network scope. Omitted = all networks.',
  })
  @IsOptional()
  @IsIn(['MAINNET', 'TESTNET'])
  network?: 'MAINNET' | 'TESTNET';
}
