import {
  Injectable,
  Logger,
  NotImplementedException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface FaucetRequest {
  walletAddress: string;
  network: 'TESTNET';
  requestedAmount?: number;
}

export interface FaucetResponse {
  walletAddress: string;
  amountSent: number;
  transactionId: string;
  timestamp: Date;
}

export interface ThrottleEntry {
  count: number;
  firstRequestAt: Date;
  lastRequestAt: Date;
}

/**
 * Service for managing testnet faucet proxy requests with throttling.
 *
 * Prevents abuse by:
 * - Limiting requests per wallet address per time window
 * - Tracking request history
 * - Enforcing rate limits on proxy calls to faucet services
 *
 * MAINNET GATE: If STELLAR_NETWORK is set to anything that resolves to
 * "mainnet" (case-insensitive) this service refuses all fund requests with a
 * NotImplementedException. This is a fail-closed guard — production deployments
 * cannot accidentally trigger Friendbot or any other faucet against the live
 * Stellar network.
 */
@Injectable()
export class TestnetFaucetService {
  private readonly logger = new Logger(TestnetFaucetService.name);
  private readonly throttleMap = new Map<string, ThrottleEntry>();

  private readonly maxRequestsPerWindow: number;
  private readonly throttleWindowMs: number;
  private readonly faucetProxyUrl: string;
  /** true when the configured network is production mainnet */
  private readonly isMainnet: boolean;

  constructor(private configService: ConfigService) {
    this.maxRequestsPerWindow =
      this.configService.get<number>('TESTNET_FAUCET_MAX_REQUESTS', 5) || 5;
    this.throttleWindowMs =
      this.configService.get<number>('TESTNET_FAUCET_WINDOW_MS', 3_600_000) ||
      3_600_000; // 1 hour default
    this.faucetProxyUrl =
      this.configService.get<string>('TESTNET_FAUCET_URL', '') ||
      'https://friendbot.stellar.org';

    // Mainnet gate — read STELLAR_NETWORK; any value that resolves to "mainnet"
    // (case-insensitive) locks the faucet down. An unset/empty value is treated
    // as testnet so that development environments work without explicit config.
    const network =
      this.configService.get<string>('STELLAR_NETWORK', 'TESTNET')?.trim().toUpperCase() ||
      'TESTNET';
    this.isMainnet = network === 'MAINNET' || network === 'PUBLIC';

    if (this.isMainnet) {
      this.logger.warn(
        'TestnetFaucetService: STELLAR_NETWORK is set to mainnet/public. ' +
          'All faucet requests will be rejected (fail-closed).',
      );
    }
  }

  /**
   * Requests testnet funds from the faucet with throttling protection.
   *
   * @throws NotImplementedException when STELLAR_NETWORK=mainnet/public.
   * @throws TooManyRequestsException if throttle limit exceeded.
   */
  async requestFunds(request: FaucetRequest): Promise<FaucetResponse> {
    // MAINNET GATE — hard reject before any other logic
    if (this.isMainnet) {
      this.logger.error(
        `Faucet request rejected: STELLAR_NETWORK is mainnet. ` +
          `Wallet ${request.walletAddress} attempted faucet funding on production network.`,
      );
      throw new NotImplementedException(
        'Testnet faucet is not available on mainnet. ' +
          'Set STELLAR_NETWORK=TESTNET to enable faucet funding.',
      );
    }

    const { walletAddress } = request;

    this.checkThrottle(walletAddress);
    this.recordRequest(walletAddress);

    try {
      const response = await this.proxyFaucetRequest(request);
      this.logger.log(
        `Faucet request successful for ${walletAddress}: ${response.transactionId}`,
      );
      return response;
    } catch (error) {
      this.logger.error(
        `Faucet request failed for ${walletAddress}`,
        error instanceof Error ? error.message : error,
      );
      throw error;
    }
  }

  /**
   * Checks if wallet has exceeded throttle limit.
   *
   * Throws TooManyRequestsException if limit exceeded.
   */
  private checkThrottle(walletAddress: string): void {
    const entry = this.throttleMap.get(walletAddress);
    if (!entry) return;

    const elapsed = Date.now() - entry.firstRequestAt.getTime();
    const isWindowExpired = elapsed > this.throttleWindowMs;

    if (!isWindowExpired && entry.count >= this.maxRequestsPerWindow) {
      const retryAfterMs = this.throttleWindowMs - elapsed;
      throw new HttpException(
        `Faucet request limit exceeded. Max ${this.maxRequestsPerWindow} requests per ${this.throttleWindowMs}ms. Retry after ${retryAfterMs}ms.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (isWindowExpired) {
      this.throttleMap.delete(walletAddress);
    }
  }

  /**
   * Records a faucet request for the given wallet.
   */
  private recordRequest(walletAddress: string): void {
    const existing = this.throttleMap.get(walletAddress);

    if (!existing) {
      this.throttleMap.set(walletAddress, {
        count: 1,
        firstRequestAt: new Date(),
        lastRequestAt: new Date(),
      });
    } else {
      const elapsed = Date.now() - existing.firstRequestAt.getTime();
      if (elapsed > this.throttleWindowMs) {
        // Window expired, reset
        this.throttleMap.set(walletAddress, {
          count: 1,
          firstRequestAt: new Date(),
          lastRequestAt: new Date(),
        });
      } else {
        // Window still active, increment
        existing.count += 1;
        existing.lastRequestAt = new Date();
      }
    }
  }

  /**
   * Proxies the faucet request to the configured faucet service.
   *
   * Makes a real HTTP call to the Stellar Friendbot (or a custom faucet URL
   * configured via TESTNET_FAUCET_URL). Only callable on testnet — the mainnet
   * gate in requestFunds() prevents this from running on production.
   */
  private async proxyFaucetRequest(
    request: FaucetRequest,
  ): Promise<FaucetResponse> {
    const defaultAmount = 10_000; // Friendbot default in XLM-equivalent lumens
    const amount = request.requestedAmount ?? defaultAmount;

    const url = `${this.faucetProxyUrl}?addr=${encodeURIComponent(request.walletAddress)}`;

    const response = await axios.get<{ hash?: string; id?: string }>(url, {
      timeout: 15_000,
    });

    const txId =
      response.data?.hash ??
      response.data?.id ??
      `faucet_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    return {
      walletAddress: request.walletAddress,
      amountSent: amount,
      transactionId: txId,
      timestamp: new Date(),
    };
  }

  /**
   * Exposes the mainnet guard state for testing and health introspection.
   */
  isMainnetNetwork(): boolean {
    return this.isMainnet;
  }

  /**
   * Gets throttle information for a wallet.
   * Useful for debugging and monitoring.
   */
  getThrottleInfo(walletAddress: string): ThrottleEntry | undefined {
    const entry = this.throttleMap.get(walletAddress);
    if (!entry) return undefined;

    const elapsed = Date.now() - entry.firstRequestAt.getTime();
    if (elapsed > this.throttleWindowMs) {
      this.throttleMap.delete(walletAddress);
      return undefined;
    }

    return { ...entry };
  }

  /**
   * Clears throttle history for a wallet (admin use only).
   */
  clearThrottleEntry(walletAddress: string): void {
    this.throttleMap.delete(walletAddress);
    this.logger.warn(`Cleared throttle entry for wallet: ${walletAddress}`);
  }

  /**
   * Clears all throttle history (admin use only).
   */
  clearAllThrottleEntries(): void {
    this.throttleMap.clear();
    this.logger.warn('Cleared all throttle entries');
  }

  /**
   * Gets all active throttle entries (for monitoring).
   */
  getAllThrottleEntries(): Map<string, ThrottleEntry> {
    return new Map(this.throttleMap);
  }
}
