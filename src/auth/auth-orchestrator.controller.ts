import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  Param,
} from '@nestjs/common';
import {
  AuthOrchestrator,
  AuthenticationRequest,
  AuthenticationResult,
} from './auth-orchestrator.service';

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
   */
  @Post('authenticate')
  @HttpCode(HttpStatus.OK)
  async authenticate(
    @Body() request: AuthenticationRequest,
  ): Promise<AuthenticationResult> {
    return await this.authOrchestrator.handleAuthentication(request);
  }

  /**
   * Validation endpoint - checks if authentication is possible
   */
  @Get('validate/:authId')
  async validateAuthentication(@Param('authId') authId: string) {
    const isValid = await this.authOrchestrator.validateAuthentication(authId);
    return { valid: isValid };
  }
}
