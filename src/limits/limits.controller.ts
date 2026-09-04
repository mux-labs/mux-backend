import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Patch,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { LimitsService } from './limits.service';
import { SetLimitsDto } from './dto/set-limits.dto';
import { UpdateLimitsDto } from './dto/update-limits.dto';
import { LimitsResponseDto } from './dto/limits-response.dto';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';

@ApiTags('limits')
@Controller('wallets/:walletId/limits')
@UseGuards(FeatureFlagGuard)
@FeatureFlag('limits_api')
export class LimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @ApiOperation({
    summary: 'Set wallet transaction and daily limits',
    description: 'Set or update daily and per-transaction limits for a wallet. The read-check and write are performed atomically in a single Prisma transaction, so concurrent requests for the same wallet cannot race. Requires API key authentication. Emits limit.updated events for each limit changed.',
  })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiBody({
    type: SetLimitsDto,
    examples: {
      default: {
        value: {
          dailyLimit: 5000,
          perTransactionLimit: 1000,
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Limits set successfully. Emits limit.updated events.',
    example: {
      walletId: '123e4567-e89b-12d3-a456-426614174000',
      dailyLimit: 5000,
      perTransactionLimit: 1000,
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid input',
    example: {
      statusCode: 400,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/wallets/123/limits',
      method: 'POST',
      message: ['dailyLimit must be positive'],
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Wallet not found',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/wallets/invalid/limits',
      method: 'POST',
      message: 'Wallet not found',
      error: 'Not Found',
    },
  })
  @Post()
  setLimits(@Param('walletId') walletId: string, @Body() dto: SetLimitsDto) {
    return this.limitsService.setLimits(
      walletId,
      dto.dailyLimit,
      dto.perTransactionLimit,
    );
  }

  @ApiOperation({
    summary: 'Get wallet limits',
    description: 'Retrieve current daily and per-transaction limits for a wallet, including remaining daily limit. Requires API key authentication.',
  })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Wallet limits retrieved successfully',
    type: LimitsResponseDto,
    example: {
      walletId: '123e4567-e89b-12d3-a456-426614174000',
      dailyLimit: 5000,
      perTransactionLimit: 1000,
      remainingDailyLimit: 2500,
    },
  })
  @ApiResponse({
    status: 404,
    description: 'No limits found for wallet',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/wallets/123/limits',
      method: 'GET',
      message: 'No limits found for wallet',
      error: 'Not Found',
    },
  })
  @ApiResponse({
    status: 422,
    description: 'Limit exceeded - transaction blocked',
    example: {
      statusCode: 422,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/payments',
      message: 'Per-transaction limit exceeded. Limit: 1000',
      error: 'Unprocessable Entity',
      errorCode: 'LIMIT_PER_TX_EXCEEDED',
    },
  })
  @Get()
  getLimits(@Param('walletId') walletId: string) {
    return this.limitsService.getLimits(walletId);
  }

  @ApiOperation({
    summary: 'Update wallet limits',
    description: 'Partially update daily and/or per-transaction limits for a wallet. At least one limit must be provided. Requires API key authentication. Emits limit.updated events for each limit changed.',
  })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiBody({
    type: UpdateLimitsDto,
    examples: {
      daily: {
        summary: 'Update daily limit only',
        value: {
          dailyLimit: 10000,
        },
      },
      perTx: {
        summary: 'Update per-transaction limit only',
        value: {
          perTransactionLimit: 2000,
        },
      },
      both: {
        summary: 'Update both limits',
        value: {
          dailyLimit: 10000,
          perTransactionLimit: 2000,
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Limits updated successfully. Emits limit.updated events.',
    example: {
      walletId: '123e4567-e89b-12d3-a456-426614174000',
      dailyLimit: 10000,
      perTransactionLimit: 2000,
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid input or no limits provided',
    example: {
      statusCode: 400,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/wallets/123/limits',
      method: 'PATCH',
      message: ['dailyLimit must be positive'],
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'No limits found for wallet',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/wallets/123/limits',
      method: 'PATCH',
      message: 'No limits found for wallet 123',
      error: 'Not Found',
    },
  })
  @Patch()
  updateLimits(@Param('walletId') walletId: string, @Body() dto: UpdateLimitsDto) {
    return this.limitsService.updateLimits(walletId, dto.dailyLimit, dto.perTransactionLimit);
  }

  @ApiOperation({
    summary: 'Remove wallet limits',
    description: 'Delete all limits for a wallet. Requires API key authentication.',
  })
  @ApiParam({ name: 'walletId', description: 'Wallet ID (UUID)' })
  @ApiResponse({
    status: 204,
    description: 'Limits removed successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'No limits found for wallet',
    example: {
      statusCode: 404,
      timestamp: '2024-06-24T12:34:56.789Z',
      path: '/wallets/123/limits',
      method: 'DELETE',
      message: 'No limits found for wallet 123',
      error: 'Not Found',
    },
  })
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  removeLimits(@Param('walletId') walletId: string) {
    return this.limitsService.removeLimits(walletId);
  }
}
