import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server } from 'stellar-sdk';
import { Asset, AssetType, BalanceUpdate } from './domain/balance.model';
import { WalletNetwork } from '../wallets/domain/wallet.model';

export interface HorizonAccountResponse {
  id: string;
  sequence: string;
  balances: HorizonBalance[];
}
import { RequestContextService } from '../common/request-context/request-context.service';
import {
  CircuitBreaker,
  CircuitOpenError,
} from '../common/utils/circuit-breaker';
import { HorizonAccountCacheService } from './horizon-account-cache.service';

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

@Injectable()
export class StellarHorizonService {
  private readonly logger = new Logger(StellarHorizonService.name);
  private readonly horizonUrls: Record<WalletNetwork, string>;
  private readonly server: Server;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(
    private readonly configService: ConfigService,
    private readonly requestContext: RequestContextService,
    @Optional() private readonly horizonAccountCache?: HorizonAccountCacheService,
  ) {
    this.horizonUrls = {
      [WalletNetwork.TESTNET]: this.configService.get<string>(
        'STELLAR_HORIZON_TESTNET_URL',
        'https://horizon-testnet.stellar.org',
      ),
      [WalletNetwork.MAINNET]: this.configService.get<string>(
        'STELLAR_HORIZON_MAINNET_URL',
        'https://horizon.stellar.org',
      ),
    };

    const horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      this.horizonUrls[WalletNetwork.TESTNET],
    );
    this.server = new Server(horizonUrl, { allowHttp: false });
    this.circuitBreaker = new CircuitBreaker('stellar-horizon', {
      failureThreshold: this.configService.get<number>(
        'HORIZON_CIRCUIT_FAILURE_THRESHOLD',
        5,
      ),
      resetTimeoutMs: this.configService.get<number>(
        'HORIZON_CIRCUIT_RESET_TIMEOUT_MS',
        30000,
      ),
    });

    this.logger.log(`Initialized Stellar Horizon client: ${horizonUrl}`);
  }

  /**
   * Resolves the Horizon base URL for a given network. Defaults to testnet
   * when no network is specified, matching prior (single-URL) behavior.
   */
  private resolveUrl(network: WalletNetwork = WalletNetwork.TESTNET): string {
    return this.horizonUrls[network];
  }

  /**
   * Helper to execute server actions with retry & backoff, guarded by a
   * circuit breaker so a degraded Horizon backend fails fast instead of
   * queuing up retries (and their backoff delays) on every caller.
   */
  private async executeWithRetry<T>(
    operation: () => Promise<T>,
    opName: string,
  ): Promise<T> {
    const requestId = this.requestContext.getRequestId();
    const logPrefix = requestId ? `[${requestId}] ` : '';

    try {
      this.circuitBreaker.assertClosed();
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        this.logger.warn(
          `${logPrefix}Horizon API ${opName} short-circuited: ${error.message}`,
        );
        throw new ServiceUnavailableException(
          'Stellar Horizon is currently unavailable. Please try again shortly.',
        );
      }
      throw error;
    }

    const maxRetries = this.configService.get<number>('HORIZON_MAX_RETRIES', 3);
    let attempt = 0;
    while (true) {
      try {
        const result = await operation();
        this.circuitBreaker.recordSuccess();
        return result;
      } catch (error) {
        attempt++;
        if (attempt > maxRetries) {
          this.circuitBreaker.recordFailure();
          throw error;
        }
        const delay = Math.min(
          1000 * Math.pow(2, attempt) + Math.random() * 1000,
          15000,
        );
        this.logger.warn(
          `${logPrefix}Horizon API ${opName} failed (attempt ${attempt}/${maxRetries}). Retrying in ${Math.round(delay)}ms. Error: ${error.message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Fetches account balances from Stellar Horizon
   */
  async getAccountBalances(
    publicKey: string,
    network: WalletNetwork = WalletNetwork.TESTNET,
  ): Promise<BalanceUpdate[]> {
    const horizonUrl = this.resolveUrl(network);
    const requestId = this.requestContext.getRequestId();
    const logPrefix = requestId ? `[${requestId}] ` : '';

    try {
      const response = await this.executeWithRetry(
        () => this.mockHorizonRequest(publicKey, horizonUrl),
        `getAccountBalances(${publicKey.substring(0, 8)}...)`,
      );

      const balances: BalanceUpdate[] = response.balances.map((balance) => ({
        walletId: '', // Will be set by caller
        asset: this.parseAsset(balance),
        balance: balance.balance,
        ledgerSequence: parseInt(response.sequence, 10),
        timestamp: new Date(),
      }));

      this.logger.log(
        `${logPrefix}Fetched ${balances.length} balances for account ${publicKey.substring(0, 8)}...`,
      );
      return balances;
    } catch (error) {
      this.logger.error(
        `${logPrefix}Failed to fetch balances for account ${publicKey}:`,
        error,
      );
      throw new Error(`Horizon API request failed: ${error.message}`);
    }
  }

  /**
   * Checks if an account exists on-chain.
   * Results are cached for a short TTL via HorizonAccountCacheService to
   * avoid redundant Horizon round-trips in high-frequency payment flows.
   */
  async accountExists(
    publicKey: string,
    network: WalletNetwork = WalletNetwork.TESTNET,
  ): Promise<boolean> {
    const requestId = this.requestContext.getRequestId();
    const logPrefix = requestId ? `[${requestId}] ` : '';

    const cached = this.horizonAccountCache?.get(publicKey);
    if (cached !== null && cached !== undefined) {
      return cached;
    }

    try {
      await this.executeWithRetry(
        () => this.server.loadAccount(publicKey),
        `accountExists(${publicKey.substring(0, 8)}...)`,
      );
      this.horizonAccountCache?.set(publicKey, true);
      return true;
    } catch (error) {
      if (
        error?.response?.status === 404 ||
        error?.message?.includes('404') ||
        error?.name === 'NotFoundError'
      ) {
        this.horizonAccountCache?.set(publicKey, false);
        return false;
      }
      this.logger.error(
        `${logPrefix}Failed to check if account exists for ${publicKey}:`,
        error,
      );
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
    horizonUrl: string,
  ): Promise<HorizonAccountResponse> {
    this.logger.debug(`Requesting account ${publicKey} from ${horizonUrl}`);

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
