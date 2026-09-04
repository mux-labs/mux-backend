import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

/**
 * Request body for submitting an already-signed transaction envelope to
 * Stellar Horizon.
 */
export class SubmitTransactionDto {
  @ApiProperty({
    description:
      'Base64-encoded XDR of the signed transaction envelope to submit to Horizon.',
    example: 'AAAAAgAAAABiZ3gQRv9n8WD/OQ2h6M6kl9d0m5fP6K3D...',
  })
  @IsString()
  @IsNotEmpty()
  signedXdr: string;
}
