import { IsEnum, IsOptional } from 'class-validator';
import { WalletStatus } from '../domain/wallet.model';

export class UpdateWalletDto {
  @IsOptional()
  @IsEnum(WalletStatus)
  status?: WalletStatus;
}
