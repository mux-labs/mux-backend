import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { ListWalletsQueryDto } from './dto/list-wallets-query.dto';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';

/**
 * Public wallet API (`/v1/wallets`).
 *
 * NOTE (issue #691): wallet key rotation is deliberately NOT exposed here.
 * `WalletsService.rotateWalletKey` is an internal custody operation, driven
 * through the internal key-management route
 * (`POST /v1/internal/key-management/rotate`, guarded by `InternalServiceGuard`).
 * Rotation creates a successor wallet rather than mutating an existing one
 * (see #692), so it is not a self-service action for API-key holders.
 */
@ApiTags('wallets')
@ApiSecurity('api-key')
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly orchestrator: WalletCreationOrchestrator,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ApiKeyGuard)
  async createWallet(
    @Body()
    body: {
      userId: string;
      network: WalletNetwork;
      idempotencyKey?: string;
    },
  ) {
    const result = await this.orchestrator.createWallet(
      body.userId,
      body.network,
      body.idempotencyKey ?? '',
    );
    return result;
  }

  /**
   * #496 / #936: List wallets with validated filters and bounded
   * offset-based pagination.
   *
   * The query is parsed into `ListWalletsQueryDto`, so an unknown `network`
   * or `status`, an out-of-range `limit`, or an unrecognized parameter is
   * rejected with `400` instead of silently widening the result set across
   * testnet and mainnet.
   */
  @ApiOperation({
    summary: 'List wallets with optional filters and pagination',
  })
  @ApiResponse({
    status: 200,
    description: 'Wallets retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        // Described structurally rather than as a `$ref`: the DTO that would
        // back that component no longer exists, and a dangling `$ref` makes
        // the published OpenAPI document invalid.
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              userId: { type: 'string' },
              publicKey: { type: 'string' },
              network: { type: 'string', enum: Object.values(WalletNetwork) },
              status: { type: 'string', enum: Object.values(WalletStatus) },
            },
          },
        },
        total: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' },
        hasMore: { type: 'boolean' },
      },
    },
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    description: 'Filter by owning user ID',
  })
  @ApiQuery({
    name: 'network',
    required: false,
    enum: WalletNetwork,
    description: 'Filter by network',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: WalletStatus,
    description: 'Filter by wallet status',
  })
  @ApiQuery({
    name: 'includeArchived',
    required: false,
    description:
      'Include archived wallets in the results (excluded by default)',
    example: false,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max records to return (1-100, default 20)',
    example: 20,
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of records to skip (default 0)',
    example: 0,
  })
  @ApiQuery({
    name: 'loadTestMode',
    required: false,
    description:
      'Return synthetic wallet data for local performance testing. Ignored ' +
      'outside non-production environments — a request with loadTestMode=true ' +
      'is rejected with 403 in production (default false).',
    example: false,
  })
  @Get()
  @UseGuards(ApiKeyGuard)
  findAll(@Query() query: ListWalletsQueryDto) {
    return this.walletsService.findAll(query);
  }

  @Get(':id')
  @UseGuards(ApiKeyGuard)
  async getWallet(@Param('id') id: string) {
    return this.walletsService.getWalletStatus(id);
  }
}
