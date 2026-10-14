import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import type {
  HorizonAccountBalances,
  HorizonBalanceClient,
} from './balance-indexer.error-codes';
import type { BalanceAssetType } from './balance-indexer.model';
/**
 * Horizon REST implementation of {@link HorizonBalanceClient}.
 *
 * Fail-closed by construction: this client throws on any transport error,
 * timeout, or non-2xx response and never returns a partial result. The
 * reconciliation service depends on that contract — if this method ever
 * resolved with an empty list on failure, a Horizon outage would be persisted
 * as "the account holds nothing" and would silently zero real balances.
 */
@Injectable()
export class HorizonRestBalanceClient implements HorizonBalanceClient {
  private readonly logger = new Logger(HorizonRestBalanceClient.name);

  /**
   * Bounds how long a single Horizon read may take. Without this a hung
   * connection would pin a request open until the client gave up.
   */
  private static readonly TIMEOUT_MS = 10_000;

  async fetchAccountBalances(
    accountId: string,
  ): Promise<HorizonAccountBalances> {
    const baseUrl = this.resolveBaseUrl();
    const response = await axios.get(
      `${baseUrl}/accounts/${encodeURIComponent(accountId)}`,
      {
        timeout: HorizonRestBalanceClient.TIMEOUT_MS,
        // Never echo the Authorization header or response body into an error.
        validateStatus: (status) => status >= 200 && status < 300,
      },
    );

    const payload = response?.data as HorizonAccountPayload | undefined;
    if (!payload || !Array.isArray(payload.balances)) {
      throw new Error('horizon account payload is missing balances');
    }

    return {
      accountId,
      ledger: Number(payload.lastModifiedLedger ?? 0),
      balances: payload.balances.map((entry) => ({
        assetType: mapAssetType(entry.asset_type),
        assetCode: entry.asset_code ?? null,
        assetIssuer: entry.asset_issuer ?? null,
        balance: entry.balance ?? '0',
      })),
    };
  }

  /**
   * Picks the Horizon base URL for the configured network. An unset or unknown
   * network throws rather than defaulting to mainnet, so a misconfigured
   * deployment cannot read (or reconcile against) the wrong chain.
   */
  private resolveBaseUrl(): string {
    const network = (
      process.env.STELLAR_NETWORK ??
      process.env.SOROBAN_NETWORK ??
      ''
    )
      .trim()
      .toLowerCase();

    if (network === 'mainnet') {
      const url = process.env.STELLAR_HORIZON_MAINNET_URL;
      if (!url) {
        throw new Error('STELLAR_HORIZON_MAINNET_URL is not configured');
      }
      return url;
    }

    if (network === 'testnet' || network === '') {
      return (
        process.env.STELLAR_HORIZON_TESTNET_URL ??
        process.env.STELLAR_HORIZON_URL ??
        'https://horizon-testnet.stellar.org'
      );
    }

    throw new Error(`unsupported STELLAR_NETWORK: ${network}`);
  }
}

/** Raw Horizon balance entry, before normalisation. */
interface HorizonAccountPayload {
  lastModifiedLedger?: string | number;
  balances?: Array<{
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
    balance?: string;
  }>;
}

/**
 * Maps a Horizon `asset_type` to the indexer's asset taxonomy.
 *
 * An unrecognised type resolves to `LIQUIDITY_POOL_SHARES` rather than
 * throwing: Horizon adds asset types over time, and refusing to index a newer
 * type would leave a real balance invisible. The value is still a valid Stellar
 * balance, it is simply classified into the catch-all bucket.
 */
function mapAssetType(assetType: string | undefined): BalanceAssetType {
  switch ((assetType ?? '').toUpperCase()) {
    case 'NATIVE':
    case 'CREDIT_ALPHANUM4':
    case 'CREDIT_ALPHANUM12':
      return assetType.toUpperCase() as BalanceAssetType;
    default:
      return 'LIQUIDITY_POOL_SHARES';
  }
}
