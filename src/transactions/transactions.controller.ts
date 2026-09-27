import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionStatusDto } from './dto/update-transaction.dto';
import { BuildTransactionDto } from './dto/build-transaction.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';
import { TransactionStatus } from './domain/transaction.model';

@Controller('transactions')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class TransactionsController {
  constructor(
    private readonly transactionsService: TransactionsService,
    private readonly stellarBuildService: StellarTransactionBuildService,
  ) {}

  /**
   * Build an unsigned Stellar payment transaction XDR.
   * The returned XDR must be signed before submission to the network.
   */
  @Post('build')
  @SensitiveEndpoint()
  buildTransaction(@Body() dto: BuildTransactionDto) {
    return this.stellarBuildService.buildPayment(dto);
  }

  @Post()
  @SensitiveEndpoint()
  create(@Body() createTransactionDto: CreateTransactionDto) {
    return this.transactionsService.create(createTransactionDto);
  }

  /**
   * List transactions with optional filters.
   *
   * Cursor pagination (preferred):
   *   GET /transactions?limit=20&cursor=<transactionId>
   *
   * Offset pagination (legacy, mutually exclusive with cursor):
   *   GET /transactions?limit=20&offset=40
   */
  @Get()
  findAll(
    @Query('senderWalletId') senderWalletId?: string,
    @Query('receiverWalletId') receiverWalletId?: string,
    @Query('status') status?: TransactionStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.transactionsService.findAll({
      senderWalletId,
      receiverWalletId,
      status: status as TransactionStatus,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      cursor,
    });
  }

  /**
   * List transactions for a specific wallet with cursor pagination.
   *
   *   GET /transactions/wallet/:walletId?limit=20&cursor=<transactionId>
   */
  @Get('wallet/:walletId')
  findByWallet(
    @Param('walletId') walletId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.transactionsService.findByWallet(walletId, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
      cursor,
    });
  }

  @Get('stellar/:hash')
  findByStellarHash(@Param('hash') hash: string) {
    return this.transactionsService.findByStellarHash(hash);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.transactionsService.findOne(id);
  }

  @Patch(':id/status')
  @SensitiveEndpoint()
  updateStatus(
    @Param('id') id: string,
    @Body() updateStatusDto: UpdateTransactionStatusDto,
  ) {
    return this.transactionsService.updateStatus(id, updateStatusDto);
  }
}
