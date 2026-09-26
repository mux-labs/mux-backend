import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findAll(
    userId?: string,
    network?: WalletNetwork,
  ): Promise<any[]> {
    try {
      return await this.prisma.wallet.findMany({
        where: {
          userId,
          network,
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      this.logger.error('DB lookup failed', { error: error.message });
      throw new ServiceUnavailableException('Wallet lookup temporarily unavailable');
    }
  }

  async getWalletStatus(id: string): Promise<any> {
    try {
      const wallet = await this.prisma.wallet.findUnique({
        where: { id },
      });

      if (!wallet) {
        throw new NotFoundException(`Wallet ${id} not found`);
      }

      return wallet;
    } catch (error) {
      this.logger.error('DB lookup failed', { id, error: error.message });
      throw new ServiceUnavailableException('Wallet lookup temporarily unavailable');
    }
  }
}
