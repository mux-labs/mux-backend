import { IsEnum, IsString, MinLength } from 'class-validator';
import { WalletNetwork } from '../domain/wallet.model';

export class CreateWalletDto {
  @IsString()
  @MinLength(1)
  userId: string;

  @IsEnum(WalletNetwork)
  network: WalletNetwork;
}
