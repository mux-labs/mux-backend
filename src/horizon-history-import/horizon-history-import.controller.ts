import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { HorizonHistoryImportService } from './horizon-history-import.service';
import { ResumeImportDto } from './dto/resume-import.dto';
import { ImportResultResponseDto } from './dto/import-result.response';
import { HorizonImportGuard } from './horizon-import.guard';
import { SensitiveEndpoint } from '../rate-limit/rate-limit.guard';

/**
 * Horizon History Import Controller
 *
 * Base path: `/horizon-import`
 *
 * Triggers (and resumes) importing a Stellar account's history
 * (payments/operations/transactions) from Stellar Horizon. Progress is
 * persisted as a Horizon paging-token cursor, so calling `resume` again
 * after a partial run or a failure continues from where the last
 * successful page left off instead of re-scanning from the beginning.
 */
@ApiTags('horizon-import')
@Controller('horizon-import')
export class HorizonHistoryImportController {
  constructor(
    private readonly historyImportService: HorizonHistoryImportService,
  ) {}

  /**
   * `POST /horizon-import/:accountId/resume`
   *
   * Fetches the next page of history for `accountId` starting at the
   * persisted cursor (or from the beginning of history if none exists
   * yet), then advances the cursor on success.
   *
   * Error responses:
   * - `400` — invalid accountId/request body, or Horizon rejected the request
   * - `404` — Stellar account not found on Horizon
   * - `503` — Horizon (or the underlying network) is unavailable
   */
  @Post(':accountId/resume')
  @HttpCode(HttpStatus.OK)
  @UseGuards(HorizonImportGuard)
  @SensitiveEndpoint()
  @ApiOperation({ summary: 'Resume Horizon history import for an account' })
  @ApiParam({ name: 'accountId', description: 'Stellar account public key' })
  @ApiResponse({
    status: 200,
    description: 'Import resumed and advanced by one page',
    type: ImportResultResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request - invalid accountId or request body',
    example: {
      statusCode: 400,
      timestamp: '2026-07-29T12:34:56.789Z',
      path: '/horizon-import/GABC/resume',
      method: 'POST',
      message: 'accountId is required',
      error: 'Bad Request',
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Stellar account not found on Horizon',
    example: {
      statusCode: 404,
      timestamp: '2026-07-29T12:34:56.789Z',
      path: '/horizon-import/GABC/resume',
      method: 'POST',
      message: 'Stellar account not found on Horizon: GABC...XYZ',
      error: 'Not Found',
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Horizon (or the network) is currently unavailable',
    example: {
      statusCode: 503,
      timestamp: '2026-07-29T12:34:56.789Z',
      path: '/horizon-import/GABC/resume',
      method: 'POST',
      message: 'Horizon server error (503)',
      error: 'Service Unavailable',
    },
  })
  async resumeImport(
    @Param('accountId') accountId: string,
    @Body(ValidationPipe) body: ResumeImportDto = new ResumeImportDto(),
  ): Promise<ImportResultResponseDto> {
    return this.historyImportService.resumeImport({
      accountId,
      network: body.network,
      resourceType: body.resourceType,
      pageLimit: body.pageLimit,
    });
  }

  /**
   * `GET /horizon-import/:accountId/cursor`
   *
   * Returns the currently persisted cursor state for the account +
   * resource stream, or `null` if no import has run yet.
   */
  @Get(':accountId/cursor')
  @ApiOperation({ summary: 'Get persisted Horizon import cursor for an account' })
  @ApiParam({ name: 'accountId', description: 'Stellar account public key' })
  @ApiResponse({ status: 200, description: 'Cursor state (or null if none exists)' })
  async getCursor(
    @Param('accountId') accountId: string,
    @Query(ValidationPipe) query: ResumeImportDto = new ResumeImportDto(),
  ) {
    return this.historyImportService.getCursor(
      accountId,
      query.resourceType,
      query.network,
    );
  }
}
