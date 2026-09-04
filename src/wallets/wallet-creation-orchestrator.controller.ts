import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Headers,
  ConflictException,
  NotFoundException,
  BadRequestException,
  UseGuards,
  UseInterceptors,
  InternalServerErrorException,
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
  type WalletOrchestrationResult,
  type OrchestratorListResult,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';
import { ResponseSanitizerInterceptor } from '../common/interceptors/response-sanitizer.interceptor';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';

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

@ApiTags('wallets-orchestration')
@ApiSecurity('api-key')
@Controller('wallets/orchestration')
@FeatureFlag('wallet_orchestrator')
@UseGuards(FeatureFlagGuard, ApiKeyGuard, RateLimitGuard)
@UseInterceptors(ResponseSanitizerInterceptor)
export class WalletCreationOrchestratorController {
  constructor(
    private readonly walletCreationOrchestrator: WalletCreationOrchestrator,
  ) {}

  @ApiOperation({
    summary: 'Create or retrieve a wallet for a user',
    description:
      'Orchestrates the full wallet creation lifecycle including key generation, ' +
      'encryption, and two-phase DB commit. Supports idempotency via the optional ' +
      'idempotencyKey field. Returns an existing wallet if the user already has one ' +
      'on the requested network.',
  })
  @ApiResponse({
    status: 200,
    description: 'Wallet created or retrieved successfully',
  })
  @ApiResponse({ status: 409, description: 'Idempotency key conflict' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @Post('create')
  @HttpCode(HttpStatus.OK)
  @SensitiveEndpoint()
  async createWallet(
    @Body() createWalletRequest: CreateWalletOrchestratorRequest,
    @Headers('x-request-id') requestId?: string,
  ): Promise<WalletOrchestrationResult> {
    // Explicit input validation — the global ValidationPipe covers class-validator
    // decorators on the DTO, but we guard against stale/null state here as well.
    if (!createWalletRequest?.userId?.trim()) {
      throw new BadRequestException('userId must not be empty');
    }
    if (!createWalletRequest?.network) {
      throw new BadRequestException(
        `network is required and must be one of: ${Array.from(VALID_NETWORKS).join(', ')}`,
      );
    }
    assertValidNetwork(createWalletRequest.network);

    try {
      return await this.walletCreationOrchestrator.createWallet(
        createWalletRequest,
        requestId,
      );
    } catch (error) {
      // Pass through typed HTTP exceptions unchanged
      if (error instanceof NotFoundException) throw error;
      if (error instanceof ConflictException) throw error;
      if (error instanceof BadRequestException) throw error;

      // Map orchestration-phase errors to 500 with a stable message
      if (error instanceof WalletOrchestrationError) {
        throw new InternalServerErrorException(
          `Wallet creation orchestration failed (phase: ${error.phase})`,
        );
      }

      throw new InternalServerErrorException(
        'Wallet creation orchestration failed',
      );
    }
  }

  @ApiOperation({
    summary: 'List wallets with optional filters and pagination',
    description:
      'Returns a paginated list of wallets. All filter parameters are optional ' +
      'and may be combined freely. Results are ordered newest-first.',
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
    description: 'Filter by blockchain network',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: WalletStatus,
    description: 'Filter by wallet status',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Maximum records to return (1–100, default 20)',
    example: 20,
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of records to skip for pagination (default 0)',
    example: 0,
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of wallets',
    schema: {
      example: {
        data: [],
        total: 0,
        limit: 20,
        offset: 0,
        hasMore: false,
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid pagination parameters' })
  @Get()
  async listWallets(
    @Query('userId') userId?: string,
    @Query('network') network?: WalletNetwork,
    @Query('status') status?: WalletStatus,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<OrchestratorListResult> {
    return this.walletCreationOrchestrator.listWallets({
      userId,
      network,
      status,
      limit: parsePaginationParam(limit, 'limit'),
      offset: parsePaginationParam(offset, 'offset'),
    });
  }

  @ApiOperation({
    summary: 'Get wallet by user and network',
    description:
      'Returns the wallet belonging to the specified user on the specified network, ' +
      'or 404 if none exists.',
  })
  @ApiParam({ name: 'userId', description: 'The user ID' })
  @ApiParam({
    name: 'network',
    enum: WalletNetwork,
    description: 'The blockchain network',
  })
  @ApiResponse({ status: 200, description: 'Wallet found' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  @Get('user/:userId/:network')
  async getWalletByUser(
    @Param('userId') userId: string,
    @Param('network') network: string,
  ) {
    assertValidNetwork(network);

    const wallet = await this.walletCreationOrchestrator.getWalletByUser(
      userId,
      network as WalletNetwork,
    );

    if (!wallet) {
      throw new NotFoundException(
        `Wallet not found for user ${userId} on ${network}`,
      );
    }

    return wallet;
  }

  @ApiOperation({
    summary: 'Check whether a user can create a wallet on a network',
    description:
      'Returns `{ canCreate: true }` when the user has no existing wallet on the ' +
      'specified network, and `{ canCreate: false }` when one already exists.',
  })
  @ApiParam({ name: 'userId', description: 'The user ID' })
  @ApiParam({
    name: 'network',
    enum: WalletNetwork,
    description: 'The blockchain network',
  })
  @ApiResponse({
    status: 200,
    description: 'Validation result',
    schema: { example: { canCreate: true } },
  })
  @Get('validate/:userId/:network')
  async validateUserCanCreateWallet(
    @Param('userId') userId: string,
    @Param('network') network: string,
  ) {
    assertValidNetwork(network);

    const canCreate =
      await this.walletCreationOrchestrator.validateUserCanCreateWallet(
        userId,
        network as WalletNetwork,
      );
    return { canCreate };
  }
}
