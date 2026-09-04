import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import {
  WalletCreationOrchestrator,
  type CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import { UpdateWalletNicknameDto } from './dto/update-wallet-nickname.dto';
import { SetNetworkPreferenceDto } from './dto/set-network-preference.dto';
import { WalletResponseDto } from './dto/wallet-response.dto';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { RequireApiKey } from '../api-keys/decorators/require-api-key.decorator';
import { ApiKeyCtx } from '../api-keys/decorators/api-key-context.decorator';
import type { ApiKeyContext } from '../api-keys/domain/api-key.model';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard, SensitiveEndpoint } from '../rate-limit/rate-limit.guard';
import {
  FeatureFlag,
  FeatureFlagGuard,
} from '../common/feature-flags/feature-flag.guard';

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
@UseGuards(FeatureFlagGuard, ApiKeyGuard, RateLimitGuard)
@FeatureFlag('wallets_enabled')
export class WalletsController {
  constructor(
    private readonly walletsService: WalletsService,
    private readonly walletCreationOrchestrator: WalletCreationOrchestrator,
  ) {}

  @ApiOperation({ summary: 'Create a new wallet' })
  @ApiResponse({
    status: 201,
    description: 'Wallet created successfully',
    type: WalletResponseDto,
  })
  @Post()
  create(
    @Body() createWalletDto: CreateWalletDto,
    @Headers('x-request-id') requestId?: string,
  ) {
    const createRequest: CreateWalletOrchestratorRequest = {
      userId: createWalletDto.userId,
      network: createWalletDto.network,
      idempotencyKey: createWalletDto.idempotencyKey,
    };

    return this.walletCreationOrchestrator.createWallet(
      createRequest,
      requestId,
    );
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
    description: 'Include archived wallets in the results (excluded by default)',
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
  findAll(
    @Query('userId') userId?: string,
    @Query('network') network?: WalletNetwork,
    @Query('status') status?: WalletStatus,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('loadTestMode') loadTestMode?: string,
  ) {
    return this.walletsService.findAll({
      userId,
      network,
      status,
      includeArchived: includeArchived === 'true',
      limit: parsePaginationParam(limit, 'limit'),
      offset: parsePaginationParam(offset, 'offset'),
      loadTestMode: loadTestMode === 'true',
    });
  }

  @Patch(':id/archive')
  @SensitiveEndpoint()
  archive(@Param('id') id: string, @Body('reason') reason?: string) {
    return this.walletsService.archive(id, reason);
  }

  @RequireApiKey()
  @Get('protected')
  async protectedEndpoint(@ApiKeyCtx() context: ApiKeyContext) {
    return {
      message: 'This endpoint is protected by API key',
      developer: context.developer.email,
      project: context.project.name,
    };
  }

  // #185: Expose wallet status endpoint
  @Get(':id/status')
  async getWalletStatus(@Param('id') id: string) {
    return this.walletsService.getWalletStatus(id);
  }

  // #188: Activate wallet (PROVISIONING -> ACTIVE)
  @Patch(':id/activate')
  async activateWallet(@Param('id') id: string) {
    return this.walletsService.activateWallet(id);
  }

  // #189: List wallets by userId
  @Get('user/:userId')
  async findByUserId(@Param('userId') userId: string) {
    return this.walletsService.findWalletsByUserId(userId);
  }

  @ApiOperation({
    summary: 'Find a wallet by its Stellar public key (address) and network',
    description:
      'Looks up the wallet associated with a given Stellar public key on a specific network. ' +
      'Address uniqueness is enforced at the DB level (@@unique([network, publicKey])); ' +
      'this endpoint surfaces that constraint as a human-readable query.',
  })
  @ApiParam({ name: 'publicKey', description: 'Stellar public key (G-address)' })
  @ApiQuery({
    name: 'network',
    enum: WalletNetwork,
    required: true,
    description: 'Network (MAINNET or TESTNET)',
  })
  @ApiResponse({
    status: 200,
    description: 'Wallet found',
    type: WalletResponseDto,
  })
  @ApiResponse({ status: 404, description: 'No wallet found for this public key on the given network' })
  @Get('address/:publicKey')
  async findByPublicKey(
    @Param('publicKey') publicKey: string,
    @Query('network') network: WalletNetwork,
  ) {
    if (!network) {
      throw new BadRequestException('network query parameter is required');
    }
    return this.walletsService.findByPublicKey(publicKey, network);
  }

  @ApiOperation({
    summary: "Get a user's default network preference",
    description:
      'Retrieve the persisted mainnet/testnet preference for a user. Requires API key authentication.',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @Get('users/:userId/network-preference')
  async getNetworkPreference(@Param('userId') userId: string) {
    return this.walletsService.getNetworkPreference(userId);
  }

  @ApiOperation({
    summary: "Set a user's default network preference",
    description:
      'Persist the mainnet/testnet preference for a user, used by wallet operations that do not explicitly specify a network. Requires API key authentication.',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @Put('users/:userId/network-preference')
  async setNetworkPreference(
    @Param('userId') userId: string,
    @Body() dto: SetNetworkPreferenceDto,
  ) {
    return this.walletsService.setNetworkPreference(userId, dto.network);
  }

  @ApiOperation({ summary: 'Get a wallet by ID' })
  @ApiResponse({
    status: 200,
    description: 'Wallet retrieved successfully',
    type: WalletResponseDto,
  })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.walletsService.findOne(id);
  }

  @ApiOperation({ summary: 'Update a wallet' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateWalletDto: UpdateWalletDto) {
    return this.walletsService.update(id, updateWalletDto);
  }

  @ApiOperation({ summary: 'Set or clear the nickname for a wallet' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @ApiResponse({
    status: 200,
    description: 'Wallet nickname updated',
    type: WalletResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @Patch(':id/nickname')
  updateNickname(
    @Param('id') id: string,
    @Body() dto: UpdateWalletNicknameDto,
    @Headers('x-request-id') requestId?: string,
  ) {
    return this.walletsService.updateNickname(id, dto.nickname, requestId);
  }

  @ApiOperation({ summary: 'Delete a wallet' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @ApiResponse({ status: 200, description: 'Wallet deleted' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @ApiResponse({
    status: 409,
    description:
      'Wallet has pending (PENDING/SUBMITTED) transactions and cannot be deleted',
  })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.walletsService.remove(id);
  }
}
