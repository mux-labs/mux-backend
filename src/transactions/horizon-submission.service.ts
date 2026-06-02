import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';
import { TransactionsService } from './transactions.service';
import { TransactionStatus } from './domain/transaction.model';
import {
  mapHorizonResultToStatus,
  HorizonTransactionResult,
} from './horizon-result.mapper';

export interface SubmissionResult {
  transactionId: string;
  stellarHash: string;
  status: TransactionStatus;
}

@Injectable()
export class HorizonSubmissionService {
  private readonly logger = new Logger(HorizonSubmissionService.name);
  private readonly horizonUrl: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService,
  ) {
    this.horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );
  }

  /**
   * Submits a signed XDR envelope to Horizon and persists the result.
   */
  async submitTransaction(
    transactionId: string,
    signedXdr: string,
  ): Promise<SubmissionResult> {
    let horizonResult: HorizonTransactionResult;

    try {
      const response = await axios.post<HorizonTransactionResult>(
        `${this.horizonUrl}/transactions`,
        new URLSearchParams({ tx: signedXdr }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      horizonResult = response.data;
    } catch (err) {
      const axiosErr = err as AxiosError<any>;

      if (!axiosErr.response) {
        // Network / timeout error
        throw new ServiceUnavailableException(
          `Horizon network error: ${axiosErr.message}`,
        );
      }

      const status = axiosErr.response.status;
      const body = axiosErr.response.data ?? {};

      if (status >= 400 && status < 500) {
        // Horizon rejected the transaction — extract result codes
        horizonResult = body as HorizonTransactionResult;
        const txCode =
          horizonResult.result_code ??
          horizonResult.extras?.result_codes?.transaction ??
          String(status);

        await this.persistStatus(transactionId, TransactionStatus.FAILED, txCode);
        throw new BadRequestException(
          `Horizon rejected transaction: ${txCode}`,
        );
      }

      // 5xx — surface as service unavailable
      throw new ServiceUnavailableException(
        `Horizon server error (${status})`,
      );
    }

    const mappedStatus = mapHorizonResultToStatus(horizonResult);
    const stellarHash = horizonResult.hash ?? '';

    await this.persistStatus(
      transactionId,
      mappedStatus,
      undefined,
      stellarHash,
      horizonResult.ledger,
      horizonResult.fee_charged,
    );

    this.logger.log(
      `Transaction ${transactionId} submitted — hash: ${stellarHash}, status: ${mappedStatus}`,
    );

    return { transactionId, stellarHash, status: mappedStatus };
  }

  private async persistStatus(
    transactionId: string,
    status: TransactionStatus,
    statusReason?: string,
    stellarHash?: string,
    stellarLedger?: number,
    stellarFee?: string,
  ): Promise<void> {
    await this.transactionsService.updateStatus(transactionId, {
      status,
      ...(statusReason !== undefined && { statusReason }),
      ...(stellarHash !== undefined && { stellarHash }),
      ...(stellarLedger !== undefined && { stellarLedger }),
      ...(stellarFee !== undefined && { stellarFee }),
    });
  }
}
