import { Injectable, Logger } from '@nestjs/common';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import { WalletCreationOrchestrator, CreateWalletRequest } from './orchestrator/wallet-creation.orchestrator';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(private readonly walletCreationOrchestrator: WalletCreationOrchestrator) {}

  async create(createWalletDto: CreateWalletDto) {
    this.logger.log(`Creating wallet with DTO: ${JSON.stringify(createWalletDto)}`);
    
    const request: CreateWalletRequest = {
      userId: createWalletDto.userId,
      encryptionKey: createWalletDto.encryptionKey,
    };

    return await this.walletCreationOrchestrator.createWallet(request);
  }

  findAll() {
    return `This action returns all wallets`;
  }

  findOne(id: number) {
    return `This action returns a #${id} wallet`;
  }

  async findByUserId(userId: string) {
    return await this.walletCreationOrchestrator.getWalletByUserId(userId);
  }

  update(id: number, updateWalletDto: UpdateWalletDto) {
    return `This action updates a #${id} wallet`;
  }

  remove(id: number) {
    return `This action removes a #${id} wallet`;
  }
}
