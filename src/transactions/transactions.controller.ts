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
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionStatusDto } from './dto/update-transaction.dto';
import { ApiKeyGuard } from '../auth/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';
import { TransactionStatus } from './domain/transaction.model';

@Controller('transactions')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @SensitiveEndpoint()
  create(@Body() createTransactionDto: CreateTransactionDto) {
    return this.transactionsService.create(createTransactionDto);
  }

  @Get()
  findAll(
    @Query('senderWalletId') senderWalletId?: string,
    @Query('receiverWalletId') receiverWalletId?: string,
    @Query('status') status?: TransactionStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.transactionsService.findAll({
      senderWalletId,
      receiverWalletId,
      status: status as TransactionStatus,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @Get('wallet/:walletId')
  findByWallet(@Param('walletId') walletId: string) {
    return this.transactionsService.findByWallet(walletId);
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
