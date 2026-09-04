import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  Param,
  Headers,
  Req,
  Res,
  UseGuards,
  Query,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
  ApiQuery,
  ApiHeader,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import {
  AuthOrchestrator,
  type AuthenticationRequest,
  type AuthenticationRequestWithIdempotency,
} from './auth-orchestrator.service';
import { RefreshTokenService } from './refresh-token.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { Public } from './public.decorator';
import { AuthSessionFilterDto } from './dto/auth-session-filter.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import {
  FeatureFlagGuard,
  FeatureFlag,
} from '../common/feature-flags/feature-flag.guard';

@ApiTags('auth')
@Controller('auth')
@FeatureFlag('auth_api')
@UseGuards(FeatureFlagGuard)
export class AuthOrchestratorController {
  private readonly logger = new Logger(AuthOrchestratorController.name);

  constructor(
    private readonly authOrchestrator: AuthOrchestrator,
    private readonly refreshTokenService: RefreshTokenService,
  ) {}

  /**
   * Main authentication endpoint - handles both first-time and returning users.
   *
   * - Creates user + wallet atomically on first authentication.
   * - Returns existing user + wallet for returning users.
   * - All operations are idempotent.
   * - Supports optional Idempotency-Key header for request deduplication.
   * - Protected by per-IP rate limiting to prevent brute force attacks.
   */
  @ApiOperation({
    summary: 'Authenticate a user',
    description:
      'Handles first-time and returning user authentication with JWT verification. ' +
      'Creates a user record and wallet on first login; returns existing records on repeat calls. ' +
      'Requires a valid, signed JWT token from the configured identity provider (Clerk/Better Auth). ' +
      'Identity is extracted ONLY from the verified JWT token; client-supplied authId/authProvider are ignored. ' +
      'Supports idempotent replay via the Idempotency-Key header.',
  })
  @ApiHeader({
    name: 'Authorization',
    required: true,
    description:
      'Bearer token (JWT) from the configured identity provider. ' +
      'Token must contain sub (subject) and auth_provider claims. ' +
      'Must be in format: Authorization: Bearer <jwt_token>',
    example: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Client-supplied unique key for request deduplication. Replayed requests return the ' +
      'original response with the Idempotency-Replayed: true header.',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: [],
      properties: {
        authId: {
          type: 'string',
          deprecated: true,
          description:
            'DEPRECATED: authId is now derived from the verified JWT token (sub claim). ' +
            'This field is ignored if provided in the request body.',
          example: 'google|1234567890',
        },
        email: {
          type: 'string',
          format: 'email',
          description: 'User email address (optional metadata, not from JWT)',
          example: 'alice@example.com',
        },
        displayName: {
          type: 'string',
          description: 'Human-readable display name (optional metadata, not from JWT)',
          example: 'Alice Smith',
        },
        authProvider: {
          type: 'string',
          deprecated: true,
          description:
            'DEPRECATED: authProvider is now derived from the verified JWT token (auth_provider claim). ' +
            'This field is ignored if provided in the request body.',
          example: 'GOOGLE',
        },
        network: {
          type: 'string',
          enum: ['MAINNET', 'TESTNET'],
          description: 'Stellar network for wallet creation (defaults to TESTNET)',
          example: 'TESTNET',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Authentication successful. Returns the user, wallet, and refresh token.',
    schema: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'uuid' },
            authId: { type: 'string', example: 'google|1234567890' },
            email: { type: 'string', nullable: true, example: 'alice@example.com' },
            displayName: { type: 'string', nullable: true, example: 'Alice Smith' },
            status: { type: 'string', example: 'ACTIVE' },
            authProvider: { type: 'string', example: 'GOOGLE' },
            lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
          },
        },
        wallet: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'uuid' },
            publicKey: { type: 'string', example: 'GABC...' },
            network: { type: 'string', example: 'TESTNET' },
            status: { type: 'string', example: 'ACTIVE' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        refreshToken: { type: 'string', example: 'hex-encoded-refresh-token' },
        isNewUser: { type: 'boolean', example: true },
        isNewWallet: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad request — missing Authorization header, invalid JWT format, ' +
      'bad email format, or invalid network.',
    schema: {
      example: {
        statusCode: 400,
        message: 'Authorization header with bearer token is required',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description:
      'Unauthorized — JWT token verification failed. ' +
      'Possible causes: invalid token signature, expired token, missing required claims (sub, auth_provider).',
    schema: {
      example: {
        statusCode: 401,
        message: 'Bearer token verification failed',
        error: 'Unauthorized',
      },
    },
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden — the account is not in ACTIVE status (suspended, disabled, etc.).',
    schema: {
      example: {
        statusCode: 403,
        message: 'Account is inactive',
        error: 'Forbidden',
      },
    },
  })
  @ApiResponse({
    status: 429,
    description: 'Too Many Requests — per-IP rate limit exceeded.',
    schema: {
      example: {
        statusCode: 429,
        message: 'Too many authentication attempts. Please try again later.',
        error: 'Too Many Requests',
      },
    },
  })
  @ApiResponse({
    status: 503,
    description:
      'Service Unavailable — an unclassified downstream failure occurred ' +
      '(e.g. database or Stellar network unreachable). The message is a ' +
      'consolidated, generic string; internal error details are never ' +
      'exposed to callers and are logged server-side only.',
    schema: {
      example: {
        statusCode: 503,
        message: 'Authentication failed. Please try again later.',
        error: 'Service Unavailable',
      },
    },
  })
  @Public()
  @Post('authenticate')
  @UseGuards(AuthRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async authenticate(
    @Body() request: AuthenticationRequest,
    @Headers('authorization') authorizationHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() httpRequest: Request,
    @Res() response: Response,
  ): Promise<void> {
    const requestId = crypto.randomUUID();
    const requestWithIdempotency: AuthenticationRequestWithIdempotency = {
      ...request,
      idempotencyKey,
      bearerToken: authorizationHeader,
      ipAddress: httpRequest.ip,
      userAgent: httpRequest.headers['user-agent'],
    };

    const result = await this.authOrchestrator.handleAuthentication(
      requestWithIdempotency,
    );

    // Issue a refresh token on successful authentication
    const refreshTokenValue = crypto.randomBytes(32).toString('hex');
    const refreshTokenHash = crypto
      .createHash('sha256')
      .update(refreshTokenValue)
      .digest('hex');
    const refreshTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    try {
      await this.refreshTokenService.createRefreshToken({
        userId: result.user.id,
        tokenHash: refreshTokenHash,
        expiresAt: refreshTokenExpiresAt,
      });
      this.logger.log(
        `[${requestId}] Refresh token issued for user ${result.user.id}`,
      );
    } catch (error) {
      this.logger.error(
        `[${requestId}] Failed to issue refresh token for user ${result.user.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      throw error;
    }

    // Extract and remove metadata before sending response
    const idempotencyReplayed = (result as any)._idempotencyReplayed ?? false;
    const responseBody = {
      ...result,
      refreshToken: refreshTokenValue,
    };
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
   * Sessions listing endpoint - returns the authenticated user's sessions.
   *
   * Requires authentication and is scoped to the authenticated caller's sessions only.
   * Supports filtering by account status, authProvider, and lastLoginAt date range.
   * Results are paginated and ordered by lastLoginAt descending.
   *
   * Access control: Authenticated callers can only see their own sessions,
   * never another user's sessions.
   */
  @ApiOperation({
    summary: 'List authenticated user sessions',
    description:
      'Returns a paginated list of the authenticated user\'s sessions. ' +
      'A session entry corresponds to a user record that has completed at least one login. ' +
      'Results are sorted by lastLoginAt descending. Supports filtering by status, ' +
      'authProvider, and date range. Scoped to the authenticated user only — ' +
      'callers cannot access another user\'s sessions.',
  })
  @ApiQuery({ name: 'page', required: false, example: 1, description: 'Page number (starting from 1)' })
  @ApiQuery({ name: 'limit', required: false, example: 20, description: 'Items per page (max 100)' })
  @ApiQuery({ name: 'status', required: false, enum: ['PROVISIONING', 'ACTIVE', 'RECOVERY_PENDING', 'SUSPENDED', 'DISABLED'], description: 'Filter by user account status' })
  @ApiQuery({ name: 'authProvider', required: false, example: 'GOOGLE', description: 'Filter by authentication provider' })
  @ApiQuery({ name: 'dateFrom', required: false, example: '2024-01-01T00:00:00.000Z', description: 'Filter sessions with lastLoginAt on or after this ISO date' })
  @ApiQuery({ name: 'dateTo', required: false, example: '2024-12-31T23:59:59.999Z', description: 'Filter sessions with lastLoginAt on or before this ISO date' })
  @ApiHeader({
    name: 'Authorization',
    required: true,
    description:
      'Bearer token (JWT) from the configured identity provider. ' +
      'Required for authentication. Results are scoped to the authenticated user only.',
    example: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of auth sessions.',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              authId: { type: 'string' },
              email: { type: 'string', nullable: true },
              displayName: { type: 'string', nullable: true },
              status: { type: 'string' },
              authProvider: { type: 'string' },
              lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        total: { type: 'integer', example: 42 },
        page: { type: 'integer', example: 1 },
        limit: { type: 'integer', example: 20 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — invalid pagination params or filter values.',
    schema: {
      example: {
        statusCode: 400,
        message: 'status must be one of: PROVISIONING, ACTIVE, RECOVERY_PENDING, SUSPENDED, DISABLED',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description:
      'Unauthorized — Authorization header is missing or JWT token verification failed. ' +
      'Callers must be authenticated to list sessions.',
    schema: {
      example: {
        statusCode: 401,
        message: 'Bearer token verification failed',
        error: 'Unauthorized',
      },
    },
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — Caller\'s account is suspended or inactive. ' +
      'Even though the JWT is valid, the account status prevents access.',
    schema: {
      example: {
        statusCode: 403,
        message: 'Account is suspended. Cannot authenticate.',
        error: 'Forbidden',
      },
    },
  })
  @Get('sessions')
  async listSessions(
    @Query() pagination: PaginationDto,
    @Query() filters: AuthSessionFilterDto,
    @Req() request: Request,
  ) {
    return this.authOrchestrator.listSessions({
      page: pagination.page,
      limit: pagination.limit,
      status: filters.status,
      authProvider: filters.authProvider,
      dateFrom: filters.dateFrom ? new Date(filters.dateFrom) : undefined,
      dateTo: filters.dateTo ? new Date(filters.dateTo) : undefined,
    });
  }

  /**
   * Validation endpoint - checks if authentication is possible for the given authId.
   *
   * Returns `{ valid: true }` only for existing users with ACTIVE status.
   * Returns `{ valid: false }` if the user doesn't exist or if a system-level error occurs.
   * Throws 403 Forbidden if the user exists but has INACTIVE or SUSPENDED status.
   */
  @ApiOperation({
    summary: 'Validate an auth ID',
    description:
      'Checks whether an authId can proceed with authentication. ' +
      'Returns valid: true only for existing users with ACTIVE status. ' +
      'Returns valid: false if user not found or system error occurs. ' +
      'Throws 403 Forbidden if user is INACTIVE or SUSPENDED.',
  })
  @ApiParam({ name: 'authId', description: 'External auth provider user identifier', example: 'google|1234567890' })
  @ApiResponse({
    status: 200,
    description: 'Validation result for active user.',
    schema: {
      type: 'object',
      properties: {
        valid: { type: 'boolean', example: true },
      },
    },
  })
  @ApiResponse({
    status: 403,
    description:
      'Forbidden — user exists but is INACTIVE or SUSPENDED and cannot authenticate.',
    schema: {
      example: {
        statusCode: 403,
        message: 'Account is suspended. Cannot authenticate.',
        error: 'Forbidden',
      },
    },
  })
  @Get('validate/:authId')
  @UseGuards(AuthRateLimitGuard)
  async validateAuthentication(@Param('authId') authId: string) {
    const isValid = await this.authOrchestrator.validateAuthentication(authId);
    return { valid: isValid };
  }
}
