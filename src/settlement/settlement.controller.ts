import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { SettlementService } from './settlement.service';
import { CreateSettlementDto } from './dto/create-settlement.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';

@ApiTags('settlements')
@ApiSecurity('api-key')
@Controller('settlements')
@FeatureFlag('settlements_enabled')
@UseGuards(FeatureFlagGuard, ApiKeyGuard, RateLimitGuard)
export class SettlementController {
  constructor(
    private readonly settlementService: SettlementService,
  ) {}

  @ApiOperation({
    summary: 'Process a settlement idempotently',
    description:
      'Processes a settlement between two wallets. The `tradeId` field serves as the ' +
      'idempotency key: if a settlement with the same `tradeId` has already been processed, ' +
      'the existing result is returned and no duplicate settlement is created. ' +
      'This prevents double-settlement even if the client retries the same request.',
  })
  @ApiResponse({
    status: 200,
    description: 'Settlement created or idempotent replay returned',
    schema: {
      example: {
        id: 'uuid-settlement-id',
        tradeId: 'client-trade-id-123',
        senderWalletId: 'uuid-sender-wallet',
        receiverWalletId: 'uuid-receiver-wallet',
        amount: '10.50',
        status: 'COMPLETED',
        isIdempotent: false,
        settledAt: '2026-07-25T12:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @ApiResponse({ status: 409, description: 'Duplicate tradeId conflict' })
  @Post()
  @HttpCode(HttpStatus.OK)
  async createSettlement(
    @Body() dto: CreateSettlementDto,
  ) {
    return this.settlementService.settle(dto);
  }

  @ApiOperation({
    summary: 'Get settlement by tradeId',
    description:
      'Retrieves an existing settlement by its client-supplied tradeId. ' +
      'Returns 404 if no settlement exists for the given tradeId.',
  })
  @ApiParam({
    name: 'tradeId',
    description: 'The client-supplied trade identifier',
    example: 'trade-uuid-or-reference-123',
  })
  @ApiResponse({ status: 200, description: 'Settlement found' })
  @ApiResponse({ status: 404, description: 'Settlement not found' })
  @Get(':tradeId')
  async getSettlement(@Param('tradeId') tradeId: string) {
    const result = await this.settlementService.findByTradeId(tradeId);
    if (!result) {
      throw new NotFoundException(
        `Settlement with tradeId ${tradeId} not found`,
      );
    }
    return result;
  }
}
