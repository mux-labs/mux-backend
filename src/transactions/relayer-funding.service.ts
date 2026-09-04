import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRequestIdAwareAxios } from '../common/http/request-id-axios';
import { WalletsService } from '../wallets/wallets.service';
import { BalanceIndexerService } from '../balance-indexer/balance-indexer.service';
import { AssetType } from '../balance-indexer/domain/balance.model';
import { WalletNetwork } from '../wallets/domain/wallet.model';

export interface RelayerFundingCheckResult {
  walletId: string;
  publicKey: string;
  balance: string;
  minBalance: string;
  status: 'SUFFICIENT' | 'FUNDED' | 'LOW_BALANCE_ALERT';
}

/**
 * Monitors fee-source (relayer/sponsor) wallet balances used by
 * FeeBumpService and tops them up when they drop below the configured
 * minimum. Testnet wallets are auto-funded via Friendbot; mainnet wallets
 * can never be auto-funded, so a low balance there only raises an alert.
 */
@Injectable()
export class RelayerFundingService {
  private readonly logger = new Logger(RelayerFundingService.name);
  private readonly http = createRequestIdAwareAxios();
  private readonly friendbotUrl: string;
  private readonly defaultMinBalance: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly walletsService: WalletsService,
    private readonly balanceIndexerService: BalanceIndexerService,
  ) {
    this.friendbotUrl = this.configService.get<string>(
      'STELLAR_FRIENDBOT_URL',
      'https://friendbot.stellar.org',
    );
    this.defaultMinBalance = this.configService.get<string>(
      'RELAYER_MIN_BALANCE_XLM',
      '5',
    );
  }

  /**
   * Checks a relayer wallet's native XLM balance and funds it (testnet only)
   * when it is below the minimum threshold.
   */
  async checkAndFundRelayer(
    walletId: string,
    minBalance = this.defaultMinBalance,
  ): Promise<RelayerFundingCheckResult> {
    const wallet = await this.walletsService.findOne(walletId);
    const balanceRecord = await this.balanceIndexerService.getBalance(
      walletId,
      { type: AssetType.NATIVE },
    );
    const currentBalance = Number(balanceRecord?.balance ?? '0');
    const threshold = Number(minBalance);

    if (currentBalance >= threshold) {
      return {
        walletId,
        publicKey: wallet.publicKey,
        balance: String(currentBalance),
        minBalance,
        status: 'SUFFICIENT',
      };
    }

    if (wallet.network !== WalletNetwork.TESTNET) {
      this.logger.error(
        `Relayer wallet ${walletId} balance ${currentBalance} is below minimum ${minBalance} on ${wallet.network} and cannot be auto-funded`,
      );
      return {
        walletId,
        publicKey: wallet.publicKey,
        balance: String(currentBalance),
        minBalance,
        status: 'LOW_BALANCE_ALERT',
      };
    }

    try {
      await this.http.get(this.friendbotUrl, {
        params: { addr: wallet.publicKey },
      });
      this.logger.log(
        `Funded relayer wallet ${walletId} via Friendbot (balance was ${currentBalance}, min ${minBalance})`,
      );
      return {
        walletId,
        publicKey: wallet.publicKey,
        balance: String(currentBalance),
        minBalance,
        status: 'FUNDED',
      };
    } catch (error) {
      this.logger.error(
        `Failed to auto-fund relayer wallet ${walletId} via Friendbot`,
        error,
      );
      throw new ServiceUnavailableException(
        'Relayer auto-funding request failed',
      );
    }
  }
}
