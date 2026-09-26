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
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import { UpdateWalletNicknameDto } from './dto/update-wallet-nickname.dto';
import { SetNetworkPreferenceDto } from './dto/set-network-preference.dto';
import { WalletResponseDto } from './dto/wallet-response.dto';
import { ListWalletsQueryDto } from './dto/list-wallets-query.dto';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { RequireApiKey } from '../api-keys/decorators/require-api-key.decorator';
import { ApiKeyCtx } from '../api-keys/decorators/api-key-context.decorator';
import type { ApiKeyContext } from '../api-keys/domain/api-key.model';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';
import {
  FeatureFlag,
  FeatureFlagGuard,
} from '../common/feature-flags/feature-flag.guard';

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
    @Body() body: {
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
   * #496: List wallets with optional filters and offset-based pagination.
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
        data: {
          type: 'array',
          items: { $ref: '#/components/schemas/WalletResponseDto' },
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
  @Get()
  @UseGuards(ApiKeyGuard)
  async listWallets(@Query() query: ListWalletsQueryDto) {
    return this.walletsService.findAll(query);
  }

  @Get(':id')
  @UseGuards(ApiKeyGuard)
  async getWallet(@Param('id') id: string) {
    return this.walletsService.getWalletStatus(id);
  }

}
