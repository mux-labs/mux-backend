import { ApiProperty } from '@nestjs/swagger';

export class CreateWalletDto {
  @ApiProperty({ description: 'ID of the user who owns this wallet', example: 'usr_01abc' })
  userId!: string;

  @ApiProperty({
    description: 'Target network for the wallet',
    enum: ['MAINNET', 'TESTNET'],
    example: 'TESTNET',
  })
  network!: string;
}
