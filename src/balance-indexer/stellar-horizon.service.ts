import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Asset, AssetType, BalanceUpdate } from './domain/balance.model';

export interface HorizonAccountResponse {
  id: string;
  sequence: string;
  balances: HorizonBalance[];
}

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

/**
 * Service for interacting with Stellar Horizon API
 *
 * In production, use stellar-sdk:
 * import { Server } from 'stellar-sdk';
 */
@Injectable()
export class StellarHorizonService {
  private readonly logger = new Logger(StellarHorizonService.name);
  private readonly horizonUrl: string;

  constructor(private readonly configService: ConfigService) {
    // Default to testnet
    this.horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );

    this.logger.log(`Initialized Stellar Horizon client: ${this.horizonUrl}`);
  }

  /**
   * Fetches account balances from Stellar Horizon
   */
  async getAccountBalances(publicKey: string): Promise<BalanceUpdate[]> {
    try {

      // Simplified mock implementation
      const response = await this.mockHorizonRequest(publicKey);

      const balances: BalanceUpdate[] = response.balances.map((balance) => ({
        walletId: '', // Will be set by caller
        asset: this.parseAsset(balance),
        balance: balance.balance,
        ledgerSequence: parseInt(response.sequence, 10),
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
      await this.mockHorizonRequest(publicKey);
      return true;
    } catch (error) {
      if (error.message.includes('404')) {
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

  /**
   * Mock Horizon request (replace with real stellar-sdk in production)
   */
  private async mockHorizonRequest(
    publicKey: string,
  ): Promise<HorizonAccountResponse> {
    // Simulate API call delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Mock response with realistic data
    return {
      id: publicKey,
      sequence: '123456789',
      balances: [
        {
          asset_type: 'native',
          balance: '1000.5000000',
        },
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer:
            'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          balance: '500.0000000',
        },
      ],
    };
  }
}
