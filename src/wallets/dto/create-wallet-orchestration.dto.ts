import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletNetwork } from '../domain/wallet.model';
import { VALID_NETWORKS } from '../wallet-creation-orchestrator.service';

/**
 * Request body for `POST /v1/wallets/orchestration/create`.
 *
 * A real DTO (rather than a plain interface) so the global `ValidationPipe`
 * can enforce it. This is what makes `whitelist` + `forbidNonWhitelisted`
 * effective: an oversized or unexpected field is rejected with a 400 before it
 * can reach the orchestrator, which is the adversarial-input guard for this
 * endpoint.
 */
export class CreateWalletOrchestrationDto {
  @ApiProperty({ description: 'Owner of the wallet' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId: string;

  @ApiProperty({ enum: WalletNetwork, description: 'Target network' })
  @IsIn(Array.from(VALID_NETWORKS))
  network: WalletNetwork;

  @ApiPropertyOptional({
    description:
      'Client-supplied key making retries replay-safe: a repeated call with ' +
      'the same key returns the original wallet instead of minting a new one.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey?: string;
}
