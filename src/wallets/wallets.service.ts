import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Service for managing wallets.
 */
@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns all wallets (for testing bootstrap).
   * In production, this would be paginated and filtered.
   */
  async findAll(): Promise<Array<{ id: string; address: string; status: string }>> {
    try {
      const wallets = await this.prisma.wallet.findMany({
        select: {
          id: true,
          publicKey: true,
          status: true,
        },
        take: 100,
      });
      
      return wallets.map((w) => ({
        id: w.id,
        address: w.publicKey,
        status: w.status,
      }));
    } catch (error) {
      this.logger.error('Failed to fetch wallets', error);
      throw new ServiceUnavailableException({
        code: 'WALLETS_FETCH_FAILED',
        message: 'Wallet service temporarily unavailable',
      });
    }
  }

  /**
   * Health check for the wallets module.
   */
  async healthCheck(): Promise<{ status: string }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    } catch (error) {
      this.logger.error('Wallet health check failed', error);
      return { status: 'degraded' };
    }
  }
}