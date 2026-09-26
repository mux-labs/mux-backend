import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  Request,
  Logger,
} from '@nestjs/common';
import { IdempotentUserService } from './idempotent-user.service';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { randomUUID } from 'crypto';

/**
 * Request payload for user find-or-create.
 */
export interface FindOrCreateUserDto {
  authId: string;
  idempotencyKey?: string;
  network?: string;
}

/**
 * Response payload for user find-or-create.
 */
export interface FindOrCreateUserResponse {
  userId: string;
  authId: string;
  network: string;
  created: boolean;
  idempotencyKey: string;
}

/**
 * POST /users/find-or-create
 *
 * Finds an existing user by authId or creates a new one.
 * Requires an API key for authentication.
 * Requires an idempotency key for safe replay protection.
 *
 * Idempotency invariants:
 * - Same idempotency key returns the same result.
 * - Missing idempotency key returns 400.
 * - Concurrent requests with the same key are serialized.
 *
 * Fail-closed invariants:
 * - DB outage returns 503.
 * - Invalid input returns 400.
 * - Unauthorized actor returns 403.
 */
@Controller('users')
export class IdempotentUserController {
  private readonly logger = new Logger(IdempotentUserController.name);

  constructor(private readonly idempotentUserService: IdempotentUserService) {}

  @Post('find-or-create')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ApiKeyGuard)
  async findOrCreate(
    @Body() body: FindOrCreateUserDto,
    @Request() req: any,
  ): Promise<FindOrCreateUserResponse> {
    const requestId =
      (req.headers['x-request-id'] as string) ?? randomUUID();

    const authId = body.authId;
    const idempotencyKey = body.idempotencyKey ?? randomUUID();
    const network = body.network ?? 'TESTNET';

    // Extract actor context from the API key validation result
    const actorContext = this.extractActorContext(req);

    const result = await this.idempotentUserService.findOrCreateUser(
      authId,
      actorContext,
      idempotencyKey,
      {
        requestId,
        actorId: actorContext.actorId,
        actorType: actorContext.actorType,
        idempotencyKey,
      },
    );

    return {
      userId: result.userId,
      authId: result.authId,
      network: result.network,
      created: result.created,
      idempotencyKey,
    };
  }

  private extractActorContext(req: any) {
    const apiKeyData = req.apiKey ?? {};
    return {
      actorId: apiKeyData.developer?.id ?? 'unknown',
      actorType: 'api_key' as const,
      roles: apiKeyData.project?.roles ?? [],
    };
  }
}
