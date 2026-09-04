import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { LatencySloService } from './latency-slo.service';
import { SloComplianceResult } from './slo.types';

/**
 * Exposes latency SLO compliance data for monitoring and alerting.
 *
 * These endpoints are intentionally lightweight (in-memory reads) and are
 * intended to be scraped by an internal health-check dashboard or PagerDuty
 * integration.
 */
@ApiTags('slo')
@Controller('metrics/slo')
export class SloController {
  constructor(private readonly sloService: LatencySloService) {}

  /**
   * GET /metrics/slo
   *
   * Returns compliance results for all defined latency SLOs.
   */
  @ApiOperation({
    summary: 'Get latency SLO compliance for all defined SLOs',
    description:
      'Returns measured compliance, percentile latencies, and whether each SLO is currently met.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of SLO compliance results',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sloName: { type: 'string', example: 'wallet_read' },
          thresholdMs: { type: 'number', example: 200 },
          targetCompliance: { type: 'number', example: 0.99 },
          measuredCompliance: { type: 'number', example: 0.997 },
          compliant: { type: 'boolean', example: true },
          totalRequests: { type: 'number', example: 1000 },
          requestsWithinThreshold: { type: 'number', example: 997 },
          p50Ms: { type: 'number', example: 45 },
          p95Ms: { type: 'number', example: 150 },
          p99Ms: { type: 'number', example: 190 },
        },
      },
    },
  })
  @Get()
  getAllCompliance(): SloComplianceResult[] {
    return this.sloService.getCompliance();
  }

  /**
   * GET /metrics/slo/:name
   *
   * Returns compliance for a single SLO by name.
   */
  @ApiOperation({ summary: 'Get latency SLO compliance for a specific SLO' })
  @ApiParam({
    name: 'name',
    description: 'SLO name (e.g. wallet_read, transaction_write)',
    example: 'wallet_read',
  })
  @ApiResponse({ status: 200, description: 'SLO compliance result' })
  @ApiResponse({ status: 404, description: 'SLO not found' })
  @Get(':name')
  getCompliance(@Param('name') name: string): SloComplianceResult {
    const result = this.sloService.getComplianceFor(name);
    if (!result) {
      throw new NotFoundException(`SLO "${name}" is not defined`);
    }
    return result;
  }
}
