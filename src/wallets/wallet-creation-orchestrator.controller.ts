import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import {
  WalletCreationOrchestrator,
  WalletOrchestrationError,
  VALID_NETWORKS,
  type WalletOrchestrationResult,
} from './wallet-creation-orchestrator.service';
import { CreateWalletOrchestrationDto } from './dto/create-wallet-orchestration.dto';
import { WalletNetwork } from './domain/wallet.model';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import {
  FeatureFlag,
  FeatureFlagGuard,
} from '../common/feature-flags/feature-flag.guard';

/**
 * Asserts that `value` is a supported `WalletNetwork`, failing closed with a
 * 400 rather than letting an unknown network reach the orchestrator.
 */
function assertValidNetwork(value: string): asserts value is WalletNetwork {
  if (!VALID_NETWORKS.has(value)) {
    throw new BadRequestException({
      code: 'WALLET_ORCHESTRATION_INVALID_NETWORK',
      message: `network must be one of: ${Array.from(VALID_NETWORKS).join(', ')}`,
    });
  }
}

@ApiTags('wallets-orchestration')
@ApiSecurity('api-key')
@Controller('wallets/orchestration')
@FeatureFlag('wallet_orchestrator')
@UseGuards(FeatureFlagGuard, ApiKeyGuard)
export class WalletCreationOrchestratorController {
  constructor(
    private readonly walletCreationOrchestrator: WalletCreationOrchestrator,
  ) {}

  @ApiOperation({
    summary: 'Create or retrieve a wallet for a user',
    description:
      'Creates a wallet for the given user and network, or returns the existing ' +
      'one. Retries are safe: supplying an `idempotencyKey` replays the original ' +
      'result instead of minting a second custody key.',
  })
  @ApiResponse({ status: 200, description: 'Wallet created or retrieved' })
  @ApiResponse({ status: 400, description: 'Invalid userId or network' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid API key',
  })
  @ApiResponse({
    status: 403,
    description: 'Wallet orchestrator feature flag disabled',
  })
  @ApiResponse({
    status: 409,
    description: 'Idempotency key conflict or concurrent in-flight request',
  })
  @Post('create')
  @HttpCode(HttpStatus.OK)
  async createWallet(
    @Body() body: CreateWalletOrchestrationDto,
    @Headers('x-request-id') requestId?: string,
  ): Promise<WalletOrchestrationResult> {
    // Explicit validation: the global ValidationPipe does not cover the
    // plain-object request body, so guard against blank/missing input here.
    if (!body?.userId?.trim()) {
      throw new BadRequestException({
        code: 'WALLET_ORCHESTRATION_INVALID_USER_ID',
        message: 'userId must not be empty',
      });
    }
    if (!body?.network) {
      throw new BadRequestException({
        code: 'WALLET_ORCHESTRATION_INVALID_NETWORK',
        message: `network is required and must be one of: ${Array.from(VALID_NETWORKS).join(', ')}`,
      });
    }
    assertValidNetwork(body.network);

    try {
      return await this.walletCreationOrchestrator.createWallet(body);
    } catch (err) {
      // Pass typed client-facing errors through unchanged so the caller keeps
      // the stable 4xx code rather than receiving an opaque 500.
      // Pass typed client-facing errors through unchanged so the caller keeps
      // the stable status/code. This includes 503: a dependency outage is
      // retryable, and masking it as a 500 would make the orchestrator give up
      // on a request that would succeed on retry.
      if (
        err instanceof NotFoundException ||
        err instanceof ConflictException ||
        err instanceof BadRequestException ||
        err instanceof ServiceUnavailableException
      ) {
        throw err;
      }
      if (err instanceof WalletOrchestrationError) {
        throw new InternalServerErrorException({
          code: 'WALLET_ORCHESTRATION_FAILED',
          message: `Wallet creation orchestration failed (phase: ${err.phase})`,
          requestId,
        });
      }
      throw new InternalServerErrorException({
        code: 'WALLET_ORCHESTRATION_FAILED',
        message: 'Wallet creation orchestration failed',
        requestId,
      });
    }
  }

  @ApiOperation({
    summary: 'Get wallet by user and network',
    description: 'Returns the wallet for the user on the network, or 404.',
  })
  @ApiParam({ name: 'userId', description: 'The user ID' })
  @ApiParam({ name: 'network', description: 'The blockchain network' })
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
      network,
    );
    if (!wallet) {
      throw new NotFoundException({
        code: 'WALLET_NOT_FOUND',
        message: `Wallet not found for user ${userId} on ${network}`,
      });
    }
    return wallet;
  }

  @ApiOperation({
    summary: 'Check whether a user can create a wallet on a network',
    description:
      'Returns `{ canCreate: true }` when the user has no existing wallet on the ' +
      'network, and `{ canCreate: false }` when one already exists.',
  })
  @ApiParam({ name: 'userId', description: 'The user ID' })
  @ApiParam({ name: 'network', description: 'The blockchain network' })
  @ApiResponse({ status: 200, description: 'Validation result' })
  @Get('validate/:userId/:network')
  async validateUserCanCreateWallet(
    @Param('userId') userId: string,
    @Param('network') network: string,
  ) {
    assertValidNetwork(network);

    const canCreate =
      await this.walletCreationOrchestrator.validateUserCanCreateWallet(
        userId,
        network,
      );
    return { canCreate };
  }
}
