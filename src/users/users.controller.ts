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
import { UsersService } from './users.service';
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
 */
@Controller('users')
export class UsersController {
  private readonly logger = new Logger(UsersController.name);

  constructor(private readonly usersService: UsersService) {}

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

    const result = await this.usersService.findOrCreateUser(
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
