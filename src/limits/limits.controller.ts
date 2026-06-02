import { Controller, Get, Post, Body, Patch, Param } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { CreateLimitDto } from './dto/create-limit.dto';
import { UpdateLimitDto } from './dto/update-limit.dto';

@Controller('limits')
export class LimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @Post(':userId')
  setLimits(@Param('userId') userId: string, @Body() dto: CreateLimitDto) {
    return this.limitsService.setLimits(+userId, dto.dailyLimit, dto.perTransactionLimit);
  }

  @Get(':userId')
  getLimits(@Param('userId') userId: string) {
    return this.limitsService.getLimits(+userId);
  }

  @Patch(':userId')
  updateLimits(@Param('userId') userId: string, @Body() dto: UpdateLimitDto) {
    return this.limitsService.setLimits(
      +userId,
      dto.dailyLimit!,
      dto.perTransactionLimit!,
    );
  }
}
