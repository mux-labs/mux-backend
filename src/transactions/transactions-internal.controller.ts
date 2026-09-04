import {
  BadRequestException,
  Controller,
  Post,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { TransactionPollingService } from './transaction-polling.service';
import { TransactionQueryService } from './transaction-query.service';
import { RelayerFundingService } from './relayer-funding.service';
import { CronSecretGuard } from '../common/cron/cron-secret.guard';

/**
 * Internal cron/background job endpoints for transaction management.
 * These endpoints bypass normal API key authentication and instead
 * require a shared secret header for security.
 */
@ApiTags('transactions-internal')
@Controller('transactions/internal')
@UseGuards(CronSecretGuard)
export class TransactionsInternalController {
  constructor(
    private readonly pollingService: TransactionPollingService,
    private readonly queryService: TransactionQueryService,
    private readonly relayerFundingService: RelayerFundingService,
  ) {}

  @ApiOperation({
    summary: 'Poll pending transactions for confirmation',
    description:
      'Check status of submitted transactions from Horizon and update their status. ' +
      'Requires X-Cron-Secret header with the configured cron secret. ' +
      'Internal endpoint for cron jobs or background workers.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description:
      'Maximum number of transactions to poll (default 100, max 1000)',
    example: 100,
  })
  @ApiResponse({
    status: 200,
    description: 'Poll completed',
    schema: {
      example: {
        processed: 10,
        confirmed: 7,
        failed: 2,
        errors: [],
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid X-Cron-Secret header',
  })
  @Post('poll-pending')
  pollPendingTransactions(@Query('limit') limit?: string) {
    const parsedLimit = limit ? Math.min(parseInt(limit, 10), 1000) : 100;
    return this.pollingService.pollPendingTransactions(parsedLimit);
  }

  @ApiOperation({
    summary: 'Check a relayer wallet balance and auto-fund if below minimum',
    description:
      'Checks the native XLM balance of a fee-source (relayer) wallet. Testnet ' +
      'wallets below the minimum are funded via Friendbot; mainnet wallets ' +
      'below the minimum only raise a low-balance alert. Requires X-Cron-Secret header.',
  })
  @ApiQuery({ name: 'walletId', required: true })
  @ApiQuery({ name: 'minBalance', required: false, example: '5' })
  @ApiResponse({ status: 200, description: 'Funding check result' })
  @Post('relayer-funding/check')
  checkRelayerFunding(
    @Query('walletId') walletId: string,
    @Query('minBalance') minBalance?: string,
  ) {
    if (!walletId) {
      throw new BadRequestException('walletId is required');
    }
    return this.relayerFundingService.checkAndFundRelayer(walletId, minBalance);
  }

  @ApiOperation({
    summary: 'List admin transactions stuck in PENDING status',
    description:
      'Admin endpoint to find transactions that have been in PENDING status longer than threshold. ' +
      'Useful for monitoring transaction health and identifying stuck operations. ' +
      'Requires X-Cron-Secret header with the configured cron secret.',
  })
  @ApiQuery({
    name: 'thresholdMinutes',
    required: false,
    description:
      'Consider transactions stuck if pending longer than this (default 60 minutes)',
    example: 60,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description:
      'Maximum number of transactions to return (default 100, max 1000)',
    example: 100,
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of records to skip for pagination (default 0)',
    example: 0,
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of stuck pending transactions',
    schema: {
      example: {
        data: [
          {
            id: '550e8400-e29b-41d4-a716-446655440002',
            amount: '10',
            assetType: 'NATIVE',
            status: 'PENDING',
            senderWalletId: '550e8400-e29b-41d4-a716-446655440000',
            receiverWalletId: '550e8400-e29b-41d4-a716-446655440001',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        total: 1,
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized - missing or invalid X-Cron-Secret header',
  })
  @Get('stuck-pending')
  listStuckPendingTransactions(
    @Query('thresholdMinutes') thresholdMinutes?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const parsedThreshold = thresholdMinutes
      ? Math.max(parseInt(thresholdMinutes, 10), 1)
      : 60;
    const parsedLimit = limit
      ? Math.min(Math.max(parseInt(limit, 10), 1), 1000)
      : 100;
    const parsedOffset = offset ? Math.max(parseInt(offset, 10), 0) : 0;

    return this.queryService.findStuckPendingTransactions(
      parsedThreshold,
      parsedLimit,
      parsedOffset,
    );
  }
}
