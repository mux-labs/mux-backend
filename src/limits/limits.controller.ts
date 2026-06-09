import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { LimitsService } from './limits.service';
import { IsNumber, IsPositive } from 'class-validator';

class SetLimitsDto {
  @IsNumber()
  @IsPositive()
  dailyLimit: number;

  @IsNumber()
  @IsPositive()
  perTransactionLimit: number;
}

@Controller('wallets/:walletId/limits')
export class LimitsController {
  constructor(private readonly limitsService: LimitsService) {}

  @Post()
  setLimits(@Param('walletId') walletId: string, @Body() dto: SetLimitsDto) {
    return this.limitsService.setLimits(
      walletId,
      dto.dailyLimit,
      dto.perTransactionLimit,
    );
  }

  @Get()
  getLimits(@Param('walletId') walletId: string) {
    return this.limitsService.getLimits(walletId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  removeLimits(@Param('walletId') walletId: string) {
    return this.limitsService.removeLimits(walletId);
  }
}
