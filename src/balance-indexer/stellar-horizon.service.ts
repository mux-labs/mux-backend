import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon } from 'stellar-sdk';
import { Asset, AssetType, BalanceUpdate } from './domain/balance.model';

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

@Injectable()
export class StellarHorizonService {
  private readonly logger = new Logger(StellarHorizonService.name);
  private readonly server: Horizon.Server;

  constructor(private readonly configService: ConfigService) {
    const horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );

    this.server = new Horizon.Server(horizonUrl, { allowHttp: false });
    this.logger.log(`Initialized Stellar Horizon client: ${horizonUrl}`);
  }

  /**
   * Fetches account balances from Stellar Horizon
   */
  async getAccountBalances(publicKey: string): Promise<BalanceUpdate[]> {
    try {
      const account = await this.server.loadAccount(publicKey);

      const balances: BalanceUpdate[] = account.balances.map((balance) => ({
        walletId: '',
        asset: this.parseAsset(balance as unknown as HorizonBalance),
        balance: balance.balance,
        ledgerSequence: parseInt(account.sequence, 10),
        timestamp: new Date(),
      }));

      this.logger.log(
        `Fetched ${balances.length} balances for account ${publicKey.substring(0, 8)}...`,
      );
      return balances;
    } catch (error) {
      this.logger.error(
        `Failed to fetch balances for account ${publicKey}:`,
        error,
      );
      throw new Error(`Horizon API request failed: ${error.message}`);
    }
  }

  /**
   * Checks if an account exists on-chain
   */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.server.loadAccount(publicKey);
      return true;
    } catch (error) {
      // Horizon returns a 404-style error when account is not found
      if (
        error?.response?.status === 404 ||
        error?.message?.includes('404') ||
        error?.name === 'NotFoundError'
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Parses Horizon balance format to internal Asset model
   */
  private parseAsset(horizonBalance: HorizonBalance): Asset {
    switch (horizonBalance.asset_type) {
      case 'native':
        return { type: AssetType.NATIVE };

      case 'credit_alphanum4':
        return {
          type: AssetType.CREDIT_ALPHANUM4,
          code: horizonBalance.asset_code,
          issuer: horizonBalance.asset_issuer,
        };

      case 'credit_alphanum12':
        return {
          type: AssetType.CREDIT_ALPHANUM12,
          code: horizonBalance.asset_code,
          issuer: horizonBalance.asset_issuer,
        };

      case 'liquidity_pool_shares':
        return {
          type: AssetType.LIQUIDITY_POOL_SHARES,
          code: horizonBalance.asset_code,
        };

      default:
        throw new Error(`Unknown asset type: ${horizonBalance.asset_type}`);
    }
  }
}
