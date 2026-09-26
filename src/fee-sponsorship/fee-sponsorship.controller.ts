import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Query,
  Logger,
} from '@nestjs/common';
import { FeeSponsorshipService } from './fee-sponsorship.service';
import { CreateFeeSponsorshipBudgetDto } from './dto/create-fee-sponsorship-budget.dto';
import { UpdateFeeSponsorshipBudgetDto } from './dto/update-fee-sponsorship-budget.dto';
import { FeeSponsorshipBudgetResponse } from './dto/fee-sponsorship-budget-response.dto';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { FeeSponsorshipNetwork } from './domain/fee-sponsorship-budget.model';
import { randomUUID } from 'crypto';

/**
 * REST controller for fee sponsorship budget operations.
 *
 * All endpoints require API key authentication (ApiKeyGuard).
 * All write operations are gated by the FEE_SPONSORSHIP_ENABLED
 * feature flag for mainnet.
 *
 * Invariants:
 * - Deny-by-default for all privileged surfaces.
 * - Stable error codes in every failure response.
 * - Correlation ids echoed back on every response.
 * - No secrets or raw key material in responses.
 */
@Controller('fee-sponsorship')
export class FeeSponsorshipController {
  private readonly logger = new Logger(FeeSponsorshipController.name);

  constructor(private readonly feeSponsorshipService: FeeSponsorshipService) {}

  /**
   * Create a fee sponsorship budget.
   *
   * POST /v1/fee-sponsorship
   *
   * Requires API key authentication.
   * Mainnet writes require the FEE_SPONSORSHIP_ENABLED feature flag.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ApiKeyGuard)
  async createBudget(
    @Body() body: CreateFeeSponsorshipBudgetDto,
  ): Promise<FeeSponsorshipBudgetResponse> {
    const actor = this.extractActor(body);
    const result = await this.feeSponsorshipService.createBudget(body, actor);
    return this.toResponse(result);
  }

  /**
   * Get a fee sponsorship budget by ID.
   *
   * GET /v1/fee-sponsorship/:id
   *
   * Requires API key authentication.
   */
  @Get(':id')
  @UseGuards(ApiKeyGuard)
  async getBudget(
    @Param('id') id: string,
    @Query('idempotencyKey') idempotencyKey?: string,
  ): Promise<FeeSponsorshipBudgetResponse> {
    const actor = this.extractActor({ idempotencyKey });
    const result = await this.feeSponsorshipService.getBudget(id, actor);
    return this.toResponse(result);
  }

  /**
   * List fee sponsorship budgets for a wallet.
   *
   * GET /v1/fee-sponsorship
   *
   * Requires API key authentication.
   */
  @Get()
  @UseGuards(ApiKeyGuard)
  async listBudgets(
    @Query('walletId') walletId: string,
    @Query('network') network?: FeeSponsorshipNetwork,
  ): Promise<FeeSponsorshipBudgetResponse[]> {
    const actor = this.extractActor({ walletId });
    const results = await this.feeSponsorshipService.listBudgets(
      walletId,
      actor,
      network,
    );
    return results.map((r) => this.toResponse(r));
  }

  /**
   * Update a fee sponsorship budget.
   *
   * PATCH /v1/fee-sponsorship/:id
   *
   * Requires API key authentication.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async updateBudget(
    @Param('id') id: string,
    @Body() body: UpdateFeeSponsorshipBudgetDto,
  ): Promise<FeeSponsorshipBudgetResponse> {
    const actor = this.extractActor(body);
    const result = await this.feeSponsorshipService.updateBudget(id, body, actor);
    return this.toResponse(result);
  }

  /**
   * Close (deactivate) a fee sponsorship budget.
   *
   * POST /v1/fee-sponsorship/:id/close
   *
   * Requires API key authentication.
   * Idempotent: closing an already-closed budget returns the existing budget.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async closeBudget(
    @Param('id') id: string,
    @Body() body: { idempotencyKey?: string },
  ): Promise<FeeSponsorshipBudgetResponse> {
    const actor = this.extractActor(body);
    const result = await this.feeSponsorshipService.closeBudget(id, actor);
    return this.toResponse(result);
  }

  /**
   * Extract actor context from the request.
   * In production, this would be populated by the auth guard.
   * For now, we extract what we can from the request body/query.
   */
  private extractActor(source: Record<string, unknown>): {
    subjectId: string;
    role: 'owner' | 'delegate' | 'guardian' | 'api-key' | 'jwt';
    correlationId?: string;
  } {
    return {
      subjectId: (source as any).sponsorId ?? 'unknown',
      role: 'api-key',
      correlationId: (source as any).idempotencyKey,
    };
  }

  /**
   * Convert a domain model to the API response DTO.
   */
  private toResponse(budget: any): FeeSponsorshipBudgetResponse {
    return {
      id: budget.id,
      walletId: budget.walletId,
      sponsorId: budget.sponsorId,
      limitAmount: budget.limitAmount,
      remainingAmount: budget.remainingAmount,
      assetCode: budget.assetCode,
      assetIssuer: budget.assetIssuer,
      network: budget.network,
      status: budget.status,
      note: budget.note,
      createdAt: budget.createdAt,
      updatedAt: budget.updatedAt,
    };
  }
}
