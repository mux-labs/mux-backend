import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { WalletNetwork } from '../domain/wallet.model';

export class SetNetworkPreferenceDto {
  @ApiProperty({
    enum: WalletNetwork,
    example: WalletNetwork.TESTNET,
    description:
      'Preferred network for wallet operations that do not explicitly specify one',
  })
  @IsEnum(WalletNetwork, { message: 'network must be one of MAINNET, TESTNET' })
  network: WalletNetwork;
}
