import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '../entities/payment.entity';

export class PaymentDryRunPreviewDto {
  @ApiProperty()
  senderWalletId: string;

  @ApiProperty()
  receiverWalletId: string;

  @ApiProperty()
  fromId: number;

  @ApiProperty()
  toId: number;

  @ApiProperty()
  amount: number;

  @ApiProperty()
  currency: string;

  @ApiPropertyOptional()
  assetCode?: string;

  @ApiProperty({ enum: PaymentStatus, example: PaymentStatus.PENDING })
  status: PaymentStatus;
}

export class PaymentDryRunChecksDto {
  @ApiProperty({ example: 'ACTIVE' })
  senderWallet: 'ACTIVE';

  @ApiProperty({ example: 'FOUND' })
  receiverWallet: 'FOUND';

  @ApiProperty({ example: 'PASSED' })
  paymentLimits: 'PASSED';
}

export class PaymentDryRunResponseDto {
  @ApiProperty({ example: true })
  dryRun: true;

  @ApiProperty({ example: true })
  valid: true;

  @ApiProperty({ type: PaymentDryRunPreviewDto })
  preview: PaymentDryRunPreviewDto;

  @ApiProperty({ type: PaymentDryRunChecksDto })
  checks: PaymentDryRunChecksDto;
}
