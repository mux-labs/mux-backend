import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  Param,
  Headers,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  AuthOrchestrator,
  AuthenticationRequest,
  AuthenticationResult,
  AuthenticationRequestWithIdempotency,
} from './auth-orchestrator.service';
import { Public } from './public.decorator';

@Controller('auth')
export class AuthOrchestratorController {
  constructor(private readonly authOrchestrator: AuthOrchestrator) {}

  /**
   * Main authentication endpoint - handles both first-time and returning users
   *
   * This endpoint:
   * 1. Creates user if first time
   * 2. Creates wallet if first time
   * 3. Returns existing user + wallet if already exists
   *
   * All operations are idempotent.
   * Supports optional Idempotency-Key header for request deduplication.
   * Protected by per-IP rate limiting to prevent brute force attacks.
   */
  @Post('authenticate')
  @UseGuards(AuthRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async authenticate(
    @Body() request: AuthenticationRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const requestWithIdempotency: AuthenticationRequestWithIdempotency = {
      ...request,
      idempotencyKey,
    };

    const result = await this.authOrchestrator.handleAuthentication(
      requestWithIdempotency,
    );

    // Extract and remove metadata before sending response
    const idempotencyReplayed = (result as any)._idempotencyReplayed ?? false;
    const responseBody = { ...result };
    delete (responseBody as any)._idempotencyReplayed;

    // Set idempotency-replayed header if idempotency key was provided
    if (idempotencyKey) {
      response.setHeader(
        'Idempotency-Replayed',
        idempotencyReplayed ? 'true' : 'false',
      );
    }

    response.json(responseBody);
  }

  /**
   * Validation endpoint - checks if authentication is possible
   */
  @Get('validate/:authId')
  async validateAuthentication(@Param('authId') authId: string) {
    return { valid: isValid };
  }
}
