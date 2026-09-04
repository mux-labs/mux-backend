import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { createRequestIdAwareAxios } from '../common/http/request-id-axios';
import { PrismaService } from '../prisma/prisma.service';
import { WalletNetwork } from '../wallets/domain/wallet.model';
import {
  HorizonHistoryPage,
  HorizonHistoryResourceType,
  HorizonImportStatus,
} from './domain/horizon-import.model';

const DEFAULT_RESOURCE_TYPE = HorizonHistoryResourceType.PAYMENTS;
const DEFAULT_PAGE_LIMIT = 200;

export interface ResumeHistoryImportRequest {
  /** Stellar account public key whose history is being imported */
  accountId: string;
  network?: WalletNetwork;
  resourceType?: HorizonHistoryResourceType;
  /** Horizon page size (1-200, Horizon's own max) */
  pageLimit?: number;
}

export interface ResumeHistoryImportResult {
  accountId: string;
  network: WalletNetwork;
  resourceType: HorizonHistoryResourceType;
  /** Horizon paging token the import will resume from on the next call */
  cursor: string | null;
  /** Cumulative records imported across all resumed runs for this stream */
  recordsImported: number;
  /** Records processed during this specific call */
  recordsImportedThisRun: number;
  status: HorizonImportStatus.COMPLETED;
}

/**
 * Resumable Horizon history import.
 *
 * Streams a Stellar account's history (payments/operations/transactions)
 * from Horizon page by page, persisting the last successfully processed
 * paging token ("cursor") via `HorizonImportCursor`. Re-running the import
 * for the same account + resourceType + network resumes from the persisted
 * cursor instead of re-scanning history from the beginning.
 *
 * The cursor only advances after a page has been fetched *and* the new
 * cursor value has been durably persisted. On any failure — Horizon error,
 * network error, or a persistence error — the previously persisted cursor
 * is left untouched, so the next attempt safely retries the same page.
 *
 * Environment variables:
 * - `STELLAR_HORIZON_URL`         — fallback Horizon base URL
 * - `STELLAR_HORIZON_TESTNET_URL` — testnet Horizon base URL (default: horizon-testnet.stellar.org)
 * - `STELLAR_HORIZON_MAINNET_URL` — mainnet Horizon base URL (default: horizon.stellar.org)
 */
@Injectable()
export class HorizonHistoryImportService {
  private readonly logger = new Logger(HorizonHistoryImportService.name);
  private readonly http = createRequestIdAwareAxios();

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Resumes (or starts) a Horizon history import for a Stellar account.
   */
  async resumeImport(
    request: ResumeHistoryImportRequest,
  ): Promise<ResumeHistoryImportResult> {
    const accountId = request.accountId?.trim();
    if (!accountId) {
      throw new BadRequestException('accountId is required');
    }

    const network = request.network ?? WalletNetwork.TESTNET;
    const resourceType = request.resourceType ?? DEFAULT_RESOURCE_TYPE;
    const pageLimit = this.normalizePageLimit(request.pageLimit);

    const cursorRecord = await this.prisma.horizonImportCursor.upsert({
      where: {
        accountId_resourceType_network: {
          accountId,
          resourceType,
          network,
        },
      },
      create: {
        accountId,
        resourceType,
        network,
        status: HorizonImportStatus.RUNNING,
        lastAttemptAt: new Date(),
      },
      update: {
        status: HorizonImportStatus.RUNNING,
        lastAttemptAt: new Date(),
      },
    });

    this.logger.log(
      `Resuming Horizon ${resourceType} import for account ${this.maskAccountId(accountId)} ` +
        `(network=${network}, cursor=${cursorRecord.cursor ?? '<start>'})`,
    );

    let page: HorizonHistoryPage;
    try {
      page = await this.fetchPage(
        accountId,
        resourceType,
        network,
        cursorRecord.cursor ?? null,
        pageLimit,
      );
    } catch (error) {
      await this.recordFailure(cursorRecord.id, error);
      throw this.mapHorizonError(error, accountId);
    }

    const records = page._embedded?.records ?? [];
    const newCursor =
      records.length > 0
        ? records[records.length - 1].paging_token
        : (cursorRecord.cursor ?? null);

    try {
      const updated = await this.prisma.horizonImportCursor.update({
        where: { id: cursorRecord.id },
        data: {
          cursor: newCursor,
          status: HorizonImportStatus.COMPLETED,
          recordsImported: { increment: records.length },
          lastSuccessAt: new Date(),
          lastError: null,
        },
      });

      this.logger.log(
        `Horizon ${resourceType} import resumed for account ${this.maskAccountId(accountId)}: ` +
          `${records.length} record(s) processed, cursor=${updated.cursor ?? '<start>'}`,
      );

      return {
        accountId,
        network,
        resourceType,
        cursor: updated.cursor,
        recordsImported: updated.recordsImported,
        recordsImportedThisRun: records.length,
        status: HorizonImportStatus.COMPLETED,
      };
    } catch (error) {
      // The Horizon fetch already succeeded but persisting the advanced
      // cursor failed. Best-effort mark the attempt failed (without
      // touching `cursor`) so the *next* run retries this same page rather
      // than silently appearing to have made progress.
      await this.recordFailure(cursorRecord.id, error);
      this.logger.error(
        `Failed to persist advanced cursor for account ${this.maskAccountId(accountId)}:`,
        error,
      );
      throw new ServiceUnavailableException(
        'Failed to persist Horizon import progress. Please retry.',
      );
    }
  }

  /**
   * Returns the currently persisted cursor state for an account + resource
   * stream, or `null` if no import has ever been attempted.
   */
  async getCursor(
    accountId: string,
    resourceType: HorizonHistoryResourceType = DEFAULT_RESOURCE_TYPE,
    network: WalletNetwork = WalletNetwork.TESTNET,
  ) {
    return this.prisma.horizonImportCursor.findUnique({
      where: {
        accountId_resourceType_network: {
          accountId,
          resourceType,
          network,
        },
      },
    });
  }

  private async fetchPage(
    accountId: string,
    resourceType: HorizonHistoryResourceType,
    network: WalletNetwork,
    cursor: string | null,
    limit: number,
  ): Promise<HorizonHistoryPage> {
    const baseUrl = this.resolveHorizonUrl(network);
    const response = await this.http.get<HorizonHistoryPage>(
      `${baseUrl}/accounts/${accountId}/${resourceType}`,
      {
        params: {
          order: 'asc',
          limit,
          ...(cursor ? { cursor } : {}),
        },
      },
    );
    return response.data;
  }

  private resolveHorizonUrl(network: WalletNetwork): string {
    if (network === WalletNetwork.MAINNET) {
      return this.configService.get<string>(
        'STELLAR_HORIZON_MAINNET_URL',
        'https://horizon.stellar.org',
      );
    }
    return this.configService.get<string>(
      'STELLAR_HORIZON_TESTNET_URL',
      this.configService.get<string>(
        'STELLAR_HORIZON_URL',
        'https://horizon-testnet.stellar.org',
      ),
    );
  }

  private normalizePageLimit(pageLimit?: number): number {
    if (!pageLimit || pageLimit <= 0) return DEFAULT_PAGE_LIMIT;
    return Math.min(pageLimit, 200);
  }

  /**
   * Best-effort persistence of a failed attempt. Never advances `cursor` —
   * only records status/lastError/lastAttemptAt — so a subsequent call
   * resumes from the last known-good position.
   */
  private async recordFailure(
    cursorId: string,
    error: unknown,
  ): Promise<void> {
    const message = this.sanitizeErrorMessage(error);
    try {
      await this.prisma.horizonImportCursor.update({
        where: { id: cursorId },
        data: {
          status: HorizonImportStatus.FAILED,
          lastError: message,
          lastAttemptAt: new Date(),
        },
      });
    } catch (persistError) {
      this.logger.error(
        `Failed to persist import failure state for cursor ${cursorId}`,
        persistError,
      );
    }
  }

  /**
   * Maps a Horizon/network failure into a consistent Nest HTTP exception.
   * Only ever surfaces a short status/message summary — never raw response
   * bodies, headers, or request config, which could otherwise leak
   * sensitive upstream details into API responses or logs.
   */
  private mapHorizonError(error: unknown, accountId: string): Error {
    const axiosErr = error as AxiosError;

    if (!axiosErr?.isAxiosError) {
      return error instanceof Error ? error : new Error(String(error));
    }

    if (!axiosErr.response) {
      return new ServiceUnavailableException(
        `Horizon network error: ${axiosErr.message}`,
      );
    }

    const status = axiosErr.response.status;

    if (status === 404) {
      return new NotFoundException(
        `Stellar account not found on Horizon: ${this.maskAccountId(accountId)}`,
      );
    }

    if (status >= 500) {
      return new ServiceUnavailableException(
        `Horizon server error (${status})`,
      );
    }

    return new BadRequestException(
      `Horizon rejected the import request (${status})`,
    );
  }

  private sanitizeErrorMessage(error: unknown): string {
    const axiosErr = error as AxiosError;
    if (axiosErr?.isAxiosError) {
      const status = axiosErr.response?.status;
      return status
        ? `Horizon request failed with status ${status}`
        : `Horizon network error: ${axiosErr.message}`;
    }
    return error instanceof Error ? error.message : 'Unknown import error';
  }

  private maskAccountId(accountId: string): string {
    if (accountId.length <= 8) return accountId;
    return `${accountId.substring(0, 4)}...${accountId.substring(accountId.length - 4)}`;
  }
}
