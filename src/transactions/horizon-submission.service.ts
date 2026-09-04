import {
  Injectable,
  Logger,
  Optional,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { createRequestIdAwareAxios } from '../common/http/request-id-axios';
import { TransactionsService } from './transactions.service';
import { TransactionRetryService } from './transaction-retry.service';
import { TransactionStatus } from './domain/transaction.model';
import {
  mapHorizonResultToStatus,
  isInsufficientBalanceResult,
  HorizonTransactionResult,
} from './horizon-result.mapper';
import { HorizonInsufficientBalanceException } from './domain/insufficient-balance.exception';

export interface SubmissionResult {
  transactionId: string;
  stellarHash: string;
  status: TransactionStatus;
}

@Injectable()
export class HorizonSubmissionService {
  private readonly logger = new Logger(HorizonSubmissionService.name);
  private readonly horizonUrl: string;
  private readonly http = createRequestIdAwareAxios();

  constructor(
    private readonly configService: ConfigService,
    private readonly transactionsService: TransactionsService,
    @Optional() private readonly retryService?: TransactionRetryService,
  ) {
    this.horizonUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );
  }

  /**
   * Submits a signed XDR envelope to Horizon and persists the result.
   *
   * When the target network is MAINNET, the FEATURE_MAINNET_PAYMENT_SUBMIT
   * kill-switch must be enabled or submission is rejected with 403.
   */
  async submitTransaction(
    transactionId: string,
    signedXdr: string,
    network: string = 'TESTNET',
  ): Promise<SubmissionResult> {
    this.logger.debug(
      `Submitting transaction ${transactionId} to Horizon (${this.horizonUrl})`,
    );

    let horizonResult: HorizonTransactionResult;

    try {
      const response = await this.postToHorizon(signedXdr);
      horizonResult = response.data;

      // Log comprehensive Horizon response summary in debug mode
      this.logHorizonResponseSummary(transactionId, horizonResult, response.status);
    } catch (err) {
      const axiosErr = err as AxiosError<any>;

      if (!axiosErr.response) {
        // Network / timeout error
        this.logger.debug(
          `Horizon network error for transaction ${transactionId}: ${axiosErr.message}`,
        );
        throw new ServiceUnavailableException(
          `Horizon network error: ${axiosErr.message}`,
        );
      }

      const status = axiosErr.response.status;
      const body = axiosErr.response.data ?? {};

      // Log error response summary
      this.logHorizonErrorSummary(
        transactionId,
        status,
        body as HorizonTransactionResult,
      );

      if (status >= 400 && status < 500) {
        // Horizon rejected the transaction — extract result codes
        horizonResult = body as HorizonTransactionResult;
        const txCode =
          horizonResult.result_code ??
          horizonResult.extras?.result_codes?.transaction ??
          String(status);

        await this.persistStatus(
          transactionId,
          TransactionStatus.FAILED,
          txCode,
        );

        if (isInsufficientBalanceResult(horizonResult, txCode)) {
          throw new HorizonInsufficientBalanceException(transactionId, txCode);
        }

        throw new BadRequestException(
          `Horizon rejected transaction: ${txCode}`,
        );
      }

      // 5xx — surface as service unavailable
      throw new ServiceUnavailableException(`Horizon server error (${status})`);
    }

    const mappedStatus = mapHorizonResultToStatus(horizonResult);
    const stellarHash = horizonResult.hash ?? '';

    if (mappedStatus === TransactionStatus.CONFIRMED) {
      // Horizon's classic /transactions endpoint is synchronous and can return
      // the final ledger result in one call, but PENDING can't transition
      // directly to CONFIRMED — persist the SUBMITTED milestone first.
      await this.persistStatus(transactionId, TransactionStatus.SUBMITTED);
    }

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

  /**
   * POST the signed XDR to Horizon, retrying transient errors when a
   * TransactionRetryService is wired in.
   */
  private postToHorizon(signedXdr: string) {
    const post = () =>
      this.http.post<HorizonTransactionResult>(
        `${this.horizonUrl}/transactions`,
        new URLSearchParams({ tx: signedXdr }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

    if (this.retryService) {
      return this.retryService.execute({ operation: 'horizon_submit' }, post);
    }
    return post();
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

  /**
   * Logs comprehensive Horizon response summary in debug mode.
   * Includes transaction hash, ledger, fee, and operation result codes.
   */
  private logHorizonResponseSummary(
    transactionId: string,
    result: HorizonTransactionResult,
    statusCode: number,
  ): void {
    if (!this.logger.isDebugEnabled?.()) return;

    const summary = {
      transactionId,
      statusCode,
      hash: result.hash,
      ledger: result.ledger,
      createdAt: result.created_at,
      feeCharged: result.fee_charged,
      resultCode: result.result_code,
      operationResultCodes: result.extras?.result_codes?.operations || [],
      envelopeXdr: result.envelope_xdr ? '[REDACTED]' : undefined,
      resultXdr: result.result_xdr ? '[REDACTED]' : undefined,
      source: result.source_account,
      sequenceNumber: result.sequence,
      preconditions: result.preconditions
        ? {
            timebounds: result.preconditions.timebounds,
            sorobanData: result.preconditions.soroban_data ? '[REDACTED]' : undefined,
          }
        : undefined,
    };

    this.logger.debug(
      `Horizon response for transaction ${transactionId}: ${JSON.stringify(summary)}`,
    );
  }

  /**
   * Logs comprehensive Horizon error response summary in debug mode.
   * Includes HTTP status, error codes, and failure reasons.
   */
  private logHorizonErrorSummary(
    transactionId: string,
    statusCode: number,
    errorBody: HorizonTransactionResult,
  ): void {
    if (!this.logger.isDebugEnabled?.()) return;

    const summary = {
      transactionId,
      statusCode,
      type: errorBody.type,
      title: errorBody.title,
      detail: errorBody.detail,
      resultCode: errorBody.result_code,
      transactionResultCode: errorBody.extras?.result_codes?.transaction,
      operationResultCodes: errorBody.extras?.result_codes?.operations || [],
      envelopeXdr: errorBody.envelope_xdr ? '[REDACTED]' : undefined,
      resultXdr: errorBody.result_xdr ? '[REDACTED]' : undefined,
    };

    this.logger.debug(
      `Horizon error for transaction ${transactionId}: ${JSON.stringify(summary)}`,
    );
  }
}
