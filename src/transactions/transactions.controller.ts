import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiBody,
} from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { TransactionQueryService } from './transaction-query.service';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';
import { HorizonSubmissionService } from './horizon-submission.service';
import { FeeBumpService } from './fee-bump.service';
import { SorobanService } from './soroban.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionStatusDto } from './dto/update-transaction.dto';
import { BuildTransactionDto } from './dto/build-transaction.dto';
import { SubmitTransactionDto } from './dto/submit-transaction.dto';
import { FeeBumpTransactionDto } from './dto/fee-bump-transaction.dto';
import { SorobanInvokeDto } from './dto/soroban-invoke.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';
import {
  TenantScopeGuard,
  TenantScoped,
} from '../common/guards/tenant-scope.guard';
import { TransactionStatus } from './domain/transaction.model';
import { IdempotencyReplayInterceptor } from '../common/interceptors/idempotency-replay.interceptor';

/** Parse a pagination query param, throwing 400 on invalid input */
function parsePaginationParam(
  value: string | undefined,
  name: string,
  max = 100,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestException(`${name} must be a non-negative integer`);
  }
  if (name === 'limit' && n > max) {
    throw new BadRequestException(`limit must not exceed ${max}`);
  }
  return n;
}

/** Parse an ISO date string query param, throwing 400 on invalid input */
function parseDateParam(
  value: string | undefined,
  name: string,
): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new BadRequestException(`${name} must be a valid ISO 8601 date`);
  }
  return d;
}

@Controller('transactions')
@UseGuards(ApiKeyGuard, RateLimitGuard, FeatureFlagGuard, TenantScopeGuard)
@FeatureFlag('transactions_enabled')
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly queryService: TransactionQueryService,
    private readonly stellarBuildService: StellarTransactionBuildService,
    private readonly horizonSubmissionService: HorizonSubmissionService,
    private readonly feeBumpService: FeeBumpService,
    private readonly sorobanService: SorobanService,
  ) {}

  /**
   * Build an unsigned Stellar payment transaction XDR.
   */
  @ApiOperation({ summary: 'Build an unsigned Stellar payment transaction XDR' })
  @ApiBody({
    description: 'Payment build parameters',
    examples: {
      native: {
        summary: 'Native XLM payment',
        value: {
          sourcePublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
          destinationPublicKey: 'GDEF1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
          amount: '10.5',
          assetCode: 'native',
          memo: 'Payment for services',
          network: 'TESTNET',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Returns unsigned transaction XDR string' })
  @Post('build')
  @SensitiveEndpoint()
  buildTransaction(@Body() dto: BuildTransactionDto) {
    return this.stellarBuildService.buildPayment(dto);
  }

  /**
   * Submit a signed Stellar transaction envelope to testnet/mainnet Horizon
   * and persist the resulting status on the internal transaction record.
   */
  @ApiOperation({
    summary: 'Submit a signed Stellar transaction to Horizon',
    description:
      'Submits an already-signed XDR envelope to Horizon and updates the ' +
      'matching internal transaction record with the resulting status and hash.',
  })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiBody({ type: SubmitTransactionDto })
  @ApiResponse({
    status: 201,
    description: 'Transaction submitted to Horizon',
    schema: {
      example: {
        transactionId: '550e8400-e29b-41d4-a716-446655440002',
        stellarHash: 'a1b2c3d4...',
        status: 'CONFIRMED',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid XDR or Horizon rejection' })
  @ApiResponse({
    status: 422,
    description: 'Horizon rejected the transaction due to insufficient balance',
  })
  @ApiResponse({ status: 503, description: 'Horizon unavailable' })
  @Post(':id/submit')
  @SensitiveEndpoint()
  submitTransaction(
    @Param('id') id: string,
    @Body() dto: SubmitTransactionDto,
  ) {
    return this.horizonSubmissionService.submitTransaction(id, dto.signedXdr);
  }

  /**
   * Submit a fee-bump transaction to Stellar Horizon.
   *
   * Wraps an already-signed inner transaction with a new fee-source account
   * so that the sponsor pays the network fee.  Optionally updates the status
   * of an existing internal Transaction record.
   */
  @ApiOperation({
    summary: 'Submit a fee-bump transaction to Stellar',
    description:
      'Wraps an inner signed transaction XDR with a fee-source account that sponsors ' +
      'the network fee.  The fee-source wallet must be registered in Mux ' +
      '(feeSourceWalletId) so the service can retrieve the signing key.',
  })
  @ApiBody({
    type: FeeBumpTransactionDto,
    examples: {
      testnet: {
        summary: 'Fee-bump on testnet',
        value: {
          innerTransactionXdr: 'AAAAAgAAAABiZ3gQ...',
          feeSourcePublicKey: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEF',
          feeSourceWalletId: '550e8400-e29b-41d4-a716-446655440000',
          transactionId: '550e8400-e29b-41d4-a716-446655440001',
          network: 'TESTNET',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Fee-bump transaction submitted successfully',
    schema: {
      example: {
        stellarHash: 'a1b2c3d4...',
        status: 'SUBMITTED',
        transactionId: '550e8400-e29b-41d4-a716-446655440001',
        feeCharged: '1000',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid XDR or Horizon rejection' })
  @ApiResponse({
    status: 403,
    description:
      'Mainnet payment submission is disabled (mainnet_payment_submit feature flag is off)',
  })
  @ApiResponse({ status: 503, description: 'Horizon unavailable' })
  @Post('fee-bump')
  @SensitiveEndpoint()
  submitFeeBump(@Body() dto: FeeBumpTransactionDto) {
    return this.feeBumpService.submitFeeBump(dto);
  }

  @ApiOperation({ summary: 'Invoke a Soroban smart contract method' })
  @ApiResponse({
    status: 201,
    description: 'Soroban invocation submitted and confirmed',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid invocation parameters or simulation failure',
  })
  @ApiResponse({ status: 503, description: 'Soroban RPC unavailable' })
  @Post('soroban/invoke')
  @SensitiveEndpoint()
  invokeSorobanContract(@Body() dto: SorobanInvokeDto) {
    return this.sorobanService.invokeContract(dto);
  }

  @ApiOperation({ summary: 'Create a new transaction' })
  @ApiBody({
    description: 'Transaction creation payload',
    examples: {
      nativePayment: {
        summary: 'Native XLM payment',
        value: {
          amount: '10',
          asset: { type: 'NATIVE' },
          senderWalletId: '550e8400-e29b-41d4-a716-446655440000',
          receiverWalletId: '550e8400-e29b-41d4-a716-446655440001',
          memo: 'Payment for invoice #42',
          idempotencyKey: 'inv-42-pay-1',
        },
      },
      usdcPayment: {
        summary: 'USDC payment',
        value: {
          amount: '25.00',
          asset: {
            type: 'CREDIT_ALPHANUM4',
            code: 'USDC',
            issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          },
          senderWalletId: '550e8400-e29b-41d4-a716-446655440000',
          receiverWalletId: '550e8400-e29b-41d4-a716-446655440001',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Transaction created in PENDING state' })
  @Post()
  @SensitiveEndpoint()
  @UseInterceptors(IdempotencyReplayInterceptor)
  create(@Body() createTransactionDto: CreateTransactionDto) {
    return this.transactionsService.create(createTransactionDto);
  }

  /**
   * #497: List transactions with extended filters — status, wallet, asset type/code,
   * amount range, and date range.
   */
  @ApiOperation({ summary: 'List transactions with optional filters and pagination' })
  @ApiQuery({ name: 'senderWalletId', required: false, description: 'Filter by sender wallet ID' })
  @ApiQuery({ name: 'receiverWalletId', required: false, description: 'Filter by receiver wallet ID' })
  @ApiQuery({ name: 'status', required: false, enum: TransactionStatus, description: 'Filter by transaction status' })
  @ApiQuery({ name: 'assetType', required: false, description: 'Filter by asset type (e.g. NATIVE, CREDIT_ALPHANUM4)' })
  @ApiQuery({ name: 'assetCode', required: false, description: 'Filter by asset code (e.g. USDC)' })
  @ApiQuery({ name: 'minAmount', required: false, description: 'Minimum transaction amount (inclusive)' })
  @ApiQuery({ name: 'maxAmount', required: false, description: 'Maximum transaction amount (inclusive)' })
  @ApiQuery({ name: 'createdAfter', required: false, description: 'ISO 8601 date — return transactions created after this timestamp (inclusive)' })
  @ApiQuery({ name: 'createdBefore', required: false, description: 'ISO 8601 date — return transactions created before this timestamp (inclusive)' })
  @ApiQuery({ name: 'memo', required: false, description: 'Case-insensitive substring search on transaction memo' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max records to return (1-100, default 20)', example: 20 })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of records to skip (default 0)', example: 0 })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of transactions',
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
        limit: 20,
        offset: 0,
        hasMore: false,
      },
    },
  })
  @Get()
  findAll(
    @Query('senderWalletId') senderWalletId?: string,
    @Query('receiverWalletId') receiverWalletId?: string,
    @Query('status') status?: TransactionStatus,
    @Query('assetType') assetType?: string,
    @Query('assetCode') assetCode?: string,
    @Query('minAmount') minAmount?: string,
    @Query('maxAmount') maxAmount?: string,
    @Query('createdAfter') createdAfter?: string,
    @Query('createdBefore') createdBefore?: string,
    @Query('memo') memo?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.queryService.findAll({
      senderWalletId,
      receiverWalletId,
      status: status as TransactionStatus,
      assetType,
      assetCode,
      minAmount,
      maxAmount,
      createdAfter: parseDateParam(createdAfter, 'createdAfter'),
      createdBefore: parseDateParam(createdBefore, 'createdBefore'),
      memo,
      limit: parsePaginationParam(limit, 'limit'),
      offset: parsePaginationParam(offset, 'offset'),
    });
  }

  @ApiOperation({ summary: 'List transactions for a specific wallet' })
  @ApiParam({ name: 'walletId', description: 'Wallet ID to query transactions for', example: '550e8400-e29b-41d4-a716-446655440000' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max records to return (1-100, default 20)', example: 20 })
  @ApiQuery({ name: 'offset', required: false, description: 'Number of records to skip (default 0)', example: 0 })
  @ApiResponse({ status: 200, description: 'Paginated list of wallet transactions' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @Get('wallet/:walletId')
  findByWallet(
    @Param('walletId') walletId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.transactionsService.findByWallet(walletId, {
      limit: parsePaginationParam(limit, 'limit'),
      offset: parsePaginationParam(offset, 'offset'),
    });
  }

  @ApiOperation({ summary: 'Find a transaction by Stellar transaction hash' })
  @ApiParam({ name: 'hash', description: 'Stellar transaction hash', example: 'a1b2c3d4e5f6...' })
  @ApiResponse({ status: 200, description: 'Transaction found' })
  @Get('stellar/:hash')
  findByStellarHash(@Param('hash') hash: string) {
    return this.queryService.findByStellarHash(hash);
  }

  @ApiOperation({ summary: 'Get a transaction by ID' })
  @ApiParam({ name: 'id', description: 'Transaction UUID', example: '550e8400-e29b-41d4-a716-446655440002' })
  @ApiResponse({ status: 200, description: 'Transaction found' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.queryService.findOne(id);
  }

  @ApiOperation({ summary: 'Update transaction status' })
  @ApiParam({ name: 'id', description: 'Transaction UUID' })
  @ApiBody({
    description: 'Status update payload',
    examples: {
      submit: {
        summary: 'Mark as submitted to Stellar',
        value: {
          status: 'SUBMITTED',
          stellarHash: 'a1b2c3d4e5f6789abc...',
        },
      },
      confirm: {
        summary: 'Mark as confirmed on-chain',
        value: {
          status: 'CONFIRMED',
          stellarHash: 'a1b2c3d4e5f6789abc...',
          stellarLedger: 48750123,
          stellarFee: '100',
        },
      },
      fail: {
        summary: 'Mark as failed',
        value: {
          status: 'FAILED',
          statusReason: 'Insufficient fee',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 400, description: 'Invalid status transition' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  @Patch(':id/status')
  @SensitiveEndpoint()
  updateStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateTransactionStatusDto,
  ) {
    return this.transactionsService.updateStatus(id, updateStatusDto);
  }
}
