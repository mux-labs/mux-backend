import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { ApiKeyCtx } from '../api-keys/decorators/api-key-context.decorator';
import { ApiKeyContext } from '../api-keys/domain/api-key.model';
import {
  RateLimitGuard,
  SensitiveEndpoint,
} from '../rate-limit/rate-limit.guard';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';
import {
  TenantScopeGuard,
  TenantScoped,
} from '../common/guards/tenant-scope.guard';
import {
  TransactionExportService,
  ExportFormat,
  ExportFilters,
} from './transaction-export.service';

class CreateExportJobDto {
  /** Export format: CSV (default) or JSON */
  format?: ExportFormat;

  /** Optional filters to narrow the export scope */
  filters?: ExportFilters;
}

@ApiTags('transactions')
@Controller('transactions/export')
@UseGuards(ApiKeyGuard, RateLimitGuard, FeatureFlagGuard, TenantScopeGuard)
@FeatureFlag('transactions_enabled')
export class TransactionExportController {
  constructor(private readonly exportService: TransactionExportService) {}

  // ---------------------------------------------------------------------------
  // POST /transactions/export
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Start an async transaction export job',
    description:
      'Creates an export job and begins processing in the background. ' +
      'The job is scoped to the authenticated project. ' +
      'Poll GET /transactions/export/:jobId for status and download link.',
  })
  @ApiBody({
    schema: {
      example: {
        format: 'CSV',
        filters: {
          status: 'CONFIRMED',
          createdAfter: '2026-01-01T00:00:00.000Z',
          createdBefore: '2026-07-01T00:00:00.000Z',
        },
      },
    },
  })
  @ApiResponse({
    status: 202,
    description: 'Export job accepted — poll the returned jobId for status',
    schema: {
      example: {
        jobId: 'uuid',
        status: 'PENDING',
        format: 'CSV',
        createdAt: '2026-07-27T05:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid format or filter values' })
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @SensitiveEndpoint()
  async createExportJob(
    @Body() dto: CreateExportJobDto,
    @ApiKeyCtx() ctx: ApiKeyContext,
  ) {
    const job = await this.exportService.createExportJob({
      projectId: ctx.project.id,
      requestedBy: ctx.apiKey.id,
      format: dto.format ?? 'CSV',
      filters: dto.filters,
    });

    return {
      jobId: job.id,
      projectId: job.projectId,
      format: job.format,
      status: job.status,
      createdAt: job.createdAt,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /transactions/export/jobs — list jobs for the authenticated project
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'List export jobs for the authenticated project',
  })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        jobs: [
          {
            id: 'uuid',
            format: 'CSV',
            status: 'COMPLETED',
            rowCount: 1423,
            downloadUrl: 'data:text/csv;base64,...',
            expiresAt: '2026-07-28T05:00:00.000Z',
            createdAt: '2026-07-27T05:00:00.000Z',
          },
        ],
        total: 1,
      },
    },
  })
  @Get('jobs')
  async listExportJobs(
    @ApiKeyCtx() ctx: ApiKeyContext,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const limitN = limit !== undefined ? Math.min(100, Math.max(1, parseInt(limit, 10))) : 20;
    const offsetN = offset !== undefined ? Math.max(0, parseInt(offset, 10)) : 0;

    if (isNaN(limitN) || isNaN(offsetN)) {
      throw new BadRequestException('limit and offset must be integers');
    }

    const result = await this.exportService.listExportJobs(
      ctx.project.id,
      limitN,
      offsetN,
    );

    return {
      jobs: result.jobs.map((j) => ({
        id: j.id,
        format: j.format,
        status: j.status,
        rowCount: j.rowCount,
        downloadUrl: j.downloadUrl,
        expiresAt: j.expiresAt,
        errorMessage: j.errorMessage,
        startedAt: j.startedAt,
        completedAt: j.completedAt,
        createdAt: j.createdAt,
      })),
      total: result.total,
    };
  }

  // ---------------------------------------------------------------------------
  // POST /transactions/export/:jobId/issue-link — issue short-lived signed token
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Issue a short-lived signed download link for a completed export job',
    description:
      'Generates a signed token that is valid for 1 hour (configurable via `ttlSeconds`, ' +
      'min 5 min, max 24 h). ' +
      'Use the returned `downloadUrl` to fetch the export data. ' +
      'The token can be re-issued any number of times while the job data exists.',
  })
  @ApiParam({ name: 'jobId', description: 'Export job ID' })
  @ApiQuery({
    name: 'ttlSeconds',
    required: false,
    example: 3600,
    description: 'Token validity in seconds (default 3600, min 300, max 86400)',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        jobId: 'uuid',
        token: 'eyJqb2JJZCI6InV1aWQiLCJwcm9qZWN0SWQiOiJwcm9qLXV1aWQifQ.sig',
        expiresAt: '2026-07-30T03:58:20.651Z',
        downloadUrl: '/v1/transactions/export/uuid/download?token=...',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Job is not completed or data is unavailable' })
  @ApiResponse({ status: 404, description: 'Export job not found' })
  @Post(':jobId/issue-link')
  @HttpCode(HttpStatus.OK)
  async issueDownloadLink(
    @Param('jobId') jobId: string,
    @ApiKeyCtx() ctx: ApiKeyContext,
    @Query('ttlSeconds') ttlSeconds?: string,
  ) {
    const ttlMs = ttlSeconds
      ? Math.round(parseFloat(ttlSeconds) * 1000)
      : undefined;

    if (ttlSeconds !== undefined && (isNaN(ttlMs!) || ttlMs! <= 0)) {
      throw new BadRequestException('ttlSeconds must be a positive number');
    }

    const result = await this.exportService.issueDownloadLink(
      jobId,
      ctx.project.id,
      ttlMs,
    );

    return {
      jobId,
      token: result.token,
      expiresAt: result.expiresAt,
      downloadUrl: result.downloadUrl,
    };
  }

  // ---------------------------------------------------------------------------
  // GET /transactions/export/:jobId/download — download via signed token
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Download export data using a signed token',
    description:
      'Verifies the signed token and streams the export file. ' +
      'Does **not** require API key authentication — the token is the credential. ' +
      'Returns the file as an attachment with the appropriate Content-Type header.',
  })
  @ApiParam({ name: 'jobId', description: 'Export job ID' })
  @ApiQuery({
    name: 'token',
    required: true,
    description: 'Signed download token from POST /transactions/export/:jobId/issue-link',
  })
  @ApiResponse({ status: 200, description: 'Export file streamed as an attachment' })
  @ApiResponse({ status: 400, description: 'Token invalid, expired, or job unavailable' })
  @ApiResponse({ status: 404, description: 'Export job not found' })
  @Get(':jobId/download')
  @UseGuards() // Override class-level guards — token IS the auth credential
  async downloadExport(
    @Param('jobId') jobId: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    if (!token) {
      throw new BadRequestException('token query parameter is required');
    }

    const { content, mimeType, filename } =
      await this.exportService.resolveDownload(jobId, token);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', content.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(content);
  }

  // ---------------------------------------------------------------------------
  // GET /transactions/export/:jobId — poll job status
  // ---------------------------------------------------------------------------

  @ApiOperation({
    summary: 'Get the status of a transaction export job',
    description:
      'Returns current job status. When status is COMPLETED, the `downloadUrl` ' +
      'field contains the export data as a base64-encoded data URI. ' +
      'The link is valid for 24 hours after completion.',
  })
  @ApiParam({ name: 'jobId', description: 'Export job ID returned by POST /transactions/export' })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        id: 'uuid',
        projectId: 'proj-uuid',
        format: 'CSV',
        status: 'COMPLETED',
        rowCount: 1423,
        downloadUrl: 'data:text/csv;base64,...',
        expiresAt: '2026-07-28T05:00:00.000Z',
        errorMessage: null,
        startedAt: '2026-07-27T05:00:01.000Z',
        completedAt: '2026-07-27T05:00:03.000Z',
        createdAt: '2026-07-27T05:00:00.000Z',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Export job not found for this project' })
  @Get(':jobId')
  async getExportJob(
    @Param('jobId') jobId: string,
    @ApiKeyCtx() ctx: ApiKeyContext,
  ) {
    const job = await this.exportService.getExportJob(jobId, ctx.project.id);

    return {
      id: job.id,
      projectId: job.projectId,
      format: job.format,
      status: job.status,
      rowCount: job.rowCount,
      downloadUrl: job.downloadUrl,
      expiresAt: job.expiresAt,
      errorMessage: job.errorMessage,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
    };
  }
}
