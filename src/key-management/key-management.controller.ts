import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { KeyRotationAuditService } from './key-rotation-audit.service';
import { KeyType, KeyOperation } from './domain/key-types';
import {
  DetailedKeyStatistics,
  KeyStatistics,
  StatisticsQueryParams,
} from './domain/key-statistics';
import {
  GenerateKeyInput,
  SignInput,
  ValidateInput,
  RotateInput,
} from './key-management.service';

/**
 * Controller for key management statistics and operations.
 *
 * All endpoints under /internal/key-management/* are internal-only
 * and must not be exposed to the public internet.
 */
@Controller('internal/key-management')
export class KeyManagementController {
  constructor(
    private readonly keyManagementService: KeyManagementService,
    private readonly auditService: KeyRotationAuditService,
  ) {}

  // -----------------------------------------------------------------------
  // POST /internal/key-management/generate
  // -----------------------------------------------------------------------

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generateKey(@Body() body: GenerateKeyInput) {
    return this.keyManagementService.generateKey(body);
  }

  // -----------------------------------------------------------------------
  // POST /internal/key-management/sign
  // -----------------------------------------------------------------------

  @Post('sign')
  @HttpCode(HttpStatus.OK)
  async sign(@Body() body: SignInput) {
    return this.keyManagementService.sign(body);
  }

  // -----------------------------------------------------------------------
  // POST /internal/key-management/validate
  // -----------------------------------------------------------------------

  @Post('validate')
  @HttpCode(HttpStatus.OK)
  async validate(@Body() body: ValidateInput) {
    return this.keyManagementService.validateKey(body);
  }

  // -----------------------------------------------------------------------
  // POST /internal/key-management/rotate
  // -----------------------------------------------------------------------

  @Post('rotate')
  @HttpCode(HttpStatus.OK)
  async rotate(@Body() body: RotateInput) {
    return this.keyManagementService.rotateKey(body);
  }

  // -----------------------------------------------------------------------
  // GET /internal/key-management/audit
  // -----------------------------------------------------------------------

  @Get('audit')
  @HttpCode(HttpStatus.OK)
  async getAuditLog(
    @Query('limit') limit?: number,
    @Query('operation') operation?: KeyOperation,
    @Query('keyType') keyType?: KeyType,
    @Query('success') success?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const logs = this.auditService.getAuditLogs({
      limit,
      operation,
      keyType,
      success: success !== undefined ? success === 'true' : undefined,
      startDate,
      endDate,
    });

    return { logs };
  }

  // -----------------------------------------------------------------------
  // GET /internal/key-management/statistics
  // -----------------------------------------------------------------------

  @Get('statistics')
  @HttpCode(HttpStatus.OK)
  async getStatistics(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('operation') operation?: KeyOperation,
  ): Promise<{ success: true; data: KeyStatistics }> {
    const params: StatisticsQueryParams = {
      startDate,
      endDate,
      operation,
    };

    const stats = this.keyManagementService.getStatistics(params);

    return { success: true, data: stats };
  }

  // -----------------------------------------------------------------------
  // GET /internal/key-management/statistics/detailed
  // -----------------------------------------------------------------------

  @Get('statistics/detailed')
  @HttpCode(HttpStatus.OK)
  async getDetailedStatistics(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('operation') operation?: KeyOperation,
    @Query('includeTimeSeries') includeTimeSeries?: string,
  ): Promise<{ success: true; data: DetailedKeyStatistics }> {
    const params: StatisticsQueryParams = {
      startDate,
      endDate,
      operation,
      includeTimeSeries: includeTimeSeries === 'true',
    };

    const stats = this.keyManagementService.getDetailedStatistics(params);

    return { success: true, data: stats };
  }
}