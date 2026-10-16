import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
  Request,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { UsersService } from './users.service';

/**
 * Request body for `POST /v1/users/find-or-create`.
 *
 * `authId` is the caller-supplied identity claim; it is validated here so a
 * malformed body is rejected with `400` before any service call.
 */
export class FindOrCreateUserDto {
  @ApiProperty({ description: 'Client-supplied auth identity' })
  @IsString()
  @IsNotEmpty()
  authId: string;

  @ApiPropertyOptional({ description: 'Idempotency key for the request' })
  @IsOptional()
  @IsString()
  idempotencyKey?: string;

  @ApiPropertyOptional({
    enum: ['MAINNET', 'TESTNET'],
    description: 'Network the user belongs to. Omitted = TESTNET.',
  })
  @IsOptional()
  @IsIn(['MAINNET', 'TESTNET'])
  network?: 'MAINNET' | 'TESTNET';
}

export interface FindOrCreateUserResponse {
  id: string;
  authId: string;
  network: string;
  idempotencyKey: string;
}

@ApiTags('users')
@Controller('users')
@UseGuards(ApiKeyGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('find-or-create')
  @ApiOperation({ summary: 'Find or create a user by authId' })
  @ApiResponse({ status: 200, description: 'User found or created' })
  @ApiResponse({ status: 400, description: 'Malformed request body' })
  async findOrCreate(
    @Body() body: FindOrCreateUserDto,
  ): Promise<FindOrCreateUserResponse> {
    const authId = body.authId;
    const network = body.network ?? 'TESTNET';
    const idempotencyKey = body.idempotencyKey ?? this.generateIdempotencyKey();

    // Extract actor context from the API key validation result. This throws
    // before any user is created or idempotency record is written when the
    // authenticated API key cannot be resolved to a developer.
    const actorContext = this.extractActorContext(req);

    return this.usersService.findOrCreateUser({
      authId,
      network,
      idempotencyKey,
    });
  }

    // Extract actor context from the API key validation result. This throws
    // before any user is created or idempotency record is written when the
    // authenticated API key cannot be resolved to a developer.
    const actorContext = this.extractActorContext(req);

    const result = await this.usersService.findOrCreateUser({
      authId,
      network,
      idempotencyKey,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a user by id' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(@Param('id') id: string): Promise<FindOrCreateUserResponse> {
    return this.usersService.getUser(id);
  }

  private generateIdempotencyKey(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private extractActorContext(req: any) {
    const developerId = req.apiKey?.developer?.id;
    if (!developerId) {
      throw new UnauthorizedException(
        'Authenticated API key is not associated with a developer',
      );
    }

    return {
      actorId: developerId,
      actorType: 'api_key' as const,
      roles: req.apiKey?.project?.roles ?? [],
    };
  }
}
