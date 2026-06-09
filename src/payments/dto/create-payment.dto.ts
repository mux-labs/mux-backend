import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsOptional,
  IsInt,
} from 'class-validator';

export class CreatePaymentDto {
  /** Sender wallet UUID — validated to exist and be ACTIVE before payment is created. */
  @IsString()
  @IsNotEmpty()
  walletId: string;

  /** Receiver wallet UUID — validated to exist before payment is created. */
  @IsString()
  @IsNotEmpty()
  receiverWalletId: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsNotEmpty()
  currency: string;

  @IsString()
  @IsOptional()
  description?: string;

  /** Legacy sender ID (LegacyUser.id) — required for payment record FK. */
  @IsInt()
  fromId: number;

  /** Legacy receiver ID (LegacyUser.id) — required for payment record FK. */
  @IsInt()
  toId: number;
}
