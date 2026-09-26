import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './api-key.guard';
import { ApiKeyErrorCode, ApiKeyStatus } from './domain/api-key.model';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

/**
 * API key management surface (#942).
 *
 * Every route is guarded by `ApiKeyGuard`, so the caller is always an
 * already-authenticated developer and ownership is taken from the presenting
 * key — never from the request body. Revocation takes effect immediately:
 * the very next request with the revoked key is refused.
 */
@ApiTags('api-keys')
@ApiSecurity('api-key')
@Controller('api-keys')
@UseGuards(ApiKeyGuard)
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @ApiOperation({
    summary: 'Create an API key',
    description:
      'Mints a new key for the project. The plaintext key is returned exactly ' +
      'once, at creation; only its hash is stored.',
  })
  @ApiResponse({ status: 201, description: 'Key created' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: CreateApiKeyDto) {
    const result = await this.apiKeyService.createApiKey({
      name: body.name,
      projectId: body.projectId,
      expiresAt: body.expiresAt,
      network: body.network,
    });

    return {
      id: result.apiKey.id,
      name: result.apiKey.name,
      keyPrefix: result.apiKey.keyPrefix,
      lastFour: result.apiKey.lastFour,
      network: result.apiKey.network ?? null,
      status: result.apiKey.status,
      expiresAt: result.apiKey.expiresAt ?? null,
      // Returned once and never retrievable again.
      plainTextKey: result.plainTextKey,
    };
  }

  @ApiOperation({
    summary: 'Revoke an API key',
    description:
      'Revokes the key. Revocation is immediate and idempotent: the next ' +
      'request presenting the key is refused with API_KEY_REVOKED.',
  })
  @ApiParam({ name: 'id', description: 'API key id' })
  @ApiResponse({ status: 200, description: 'Key revoked' })
  @ApiResponse({ status: 401, description: 'Missing or invalid API key' })
  @ApiResponse({
    status: 403,
    description: 'The key belongs to a different developer',
  })
  @ApiResponse({ status: 404, description: 'Unknown key id' })
  @Delete(':id')
  async revoke(@Param('id') id: string, @Req() req: any) {
    const developerId = req.apiKey?.developer?.id;
    const reason = req.headers?.['x-revoke-reason'] as string | undefined;

    const revoked = await this.apiKeyService.revokeApiKey(
      id,
      reason,
      developerId,
    );

    return {
      id: revoked.id,
      status: revoked.status ?? ApiKeyStatus.REVOKED,
      revokedAt: revoked.revokedAt ?? null,
    };
  }
}

/** Re-exported so callers can branch on the stable codes without a deep import. */
export { ApiKeyErrorCode };
