import { IsString, IsNumber, IsPositive, IsOptional } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  fromWalletId: string;

  @IsString()
  toWalletId: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  currency: string;

  @IsOptional()
  @IsString()
  description?: string;
}
