import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
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
import { SetSpendingLimitDto } from './dto/set-spending-limit.dto';
import { LimitsFilterDto } from './dto/limits-filter.dto';
import { LimitPeriod } from './dto/create-limit.dto';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';

@ApiTags('limits')
@Controller('users/:userId/spending-limits')
@UseGuards(FeatureFlagGuard)
@FeatureFlag('limits_api')
export class SpendingLimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @ApiOperation({
    summary: 'Set a per-asset spending limit for a user',
    description:
      'Create or update a per-asset spending limit for a user. Limits are enforced at payment time and are scoped per asset code (assetCode null applies across all assets, e.g. native XLM).',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiBody({ type: SetSpendingLimitDto })
  @ApiResponse({ status: 201, description: 'Spending limit set successfully' })
  @Post()
  setSpendingLimit(
    @Param('userId') userId: string,
    @Body() dto: SetSpendingLimitDto,
  ) {
    return this.limitsService.setSpendingLimit({ ...dto, userId });
  }

  @ApiOperation({
    summary: 'List per-asset spending limits for a user',
    description:
      'List the per-asset spending limits configured for a user, with optional period/active filters.',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiResponse({ status: 200, description: 'Spending limits retrieved' })
  @Get()
  getSpendingLimits(
    @Param('userId') userId: string,
    @Query() filter: LimitsFilterDto,
  ) {
    return this.limitsService.getSpendingLimits(userId, filter);
  }

  @ApiOperation({
    summary: 'Deactivate a per-asset spending limit',
    description:
      'Deactivates the matching per-asset spending limit for a user (period + asset code).',
  })
  @ApiParam({ name: 'userId', description: 'User ID (UUID)' })
  @ApiResponse({ status: 200, description: 'Spending limit deactivated' })
  @Delete()
  removeSpendingLimit(
    @Param('userId') userId: string,
    @Query('period') period: LimitPeriod,
    @Query('assetCode') assetCode?: string,
  ) {
    return this.limitsService.removeSpendingLimit(userId, period, assetCode);
  }
}
