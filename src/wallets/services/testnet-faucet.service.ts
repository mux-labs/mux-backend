import { Injectable, Logger, TooManyRequestsException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
 */
@Injectable()
export class TestnetFaucetService {
  private readonly logger = new Logger(TestnetFaucetService.name);
  private readonly throttleMap = new Map<string, ThrottleEntry>();

  private readonly maxRequestsPerWindow: number;
  private readonly throttleWindowMs: number;
  private readonly faucetProxyUrl: string;

  constructor(private configService: ConfigService) {
    this.maxRequestsPerWindow =
      this.configService.get<number>('TESTNET_FAUCET_MAX_REQUESTS', 5) || 5;
    this.throttleWindowMs =
      this.configService.get<number>('TESTNET_FAUCET_WINDOW_MS', 3600000) ||
      3600000; // 1 hour default
    this.faucetProxyUrl =
      this.configService.get<string>('TESTNET_FAUCET_URL', '') ||
      'https://faucet.testnet.example.com/api/v1/fund';
  }

  /**
   * Requests testnet funds from the faucet with throttling protection.
   *
   * Throws TooManyRequestsException if throttle limit exceeded.
   */
  async requestFunds(request: FaucetRequest): Promise<FaucetResponse> {
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
      throw new TooManyRequestsException(
        `Faucet request limit exceeded. Max ${this.maxRequestsPerWindow} requests per ${this.throttleWindowMs}ms. Retry after ${retryAfterMs}ms.`,
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
   * In production, this would make actual HTTP calls to a testnet faucet.
   * For testing/dev, this can be mocked or stubbed.
   */
  private async proxyFaucetRequest(
    request: FaucetRequest,
  ): Promise<FaucetResponse> {
    const defaultAmount = 100;
    const amount = request.requestedAmount || defaultAmount;

    // Placeholder for actual HTTP proxy to faucet service
    // In real implementation, this would be:
    // const response = await this.httpClient.post(this.faucetProxyUrl, { ... });

    return {
      walletAddress: request.walletAddress,
      amountSent: amount,
      transactionId: `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
    };
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
