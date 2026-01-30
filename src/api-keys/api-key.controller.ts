import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiKeyService,
  CreateApiKeyRequest,
} from './api-key.service';

@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * Creates a new API key for a project
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createApiKey(@Body() request: CreateApiKeyRequest) {
    const result = await this.apiKeyService.createApiKey(request);

    return {
      apiKey: {
        id: result.apiKey.id,
        name: result.apiKey.name,
        keyPrefix: result.apiKey.keyPrefix,
        lastFour: result.apiKey.lastFour,
        status: result.apiKey.status,
        createdAt: result.apiKey.createdAt,
      },
      // WARNING: This is the only time the plain text key is returned!
      plainTextKey: result.plainTextKey,
    };
  }

  /**
   * Lists all API keys for a project
   */
  @Get('project/:projectId')
  async listApiKeys(@Param('projectId') projectId: string) {
    const apiKeys = await this.apiKeyService.listApiKeys(projectId);

    // Don't return key hashes, only metadata
    return apiKeys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      lastFour: key.lastFour,
      status: key.status,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
    }));
  }

  /**
   * Revokes an API key
   */
  @Delete(':apiKeyId')
  @HttpCode(HttpStatus.OK)
  async revokeApiKey(
    @Param('apiKeyId') apiKeyId: string,
    @Body() body: { reason?: string },
  ) {
    const apiKey = await this.apiKeyService.revokeApiKey(apiKeyId, body.reason);

    return {
      id: apiKey.id,
      status: apiKey.status,
      revokedAt: apiKey.revokedAt,
      revokedReason: apiKey.revokedReason,
    };
  }

  /**
   * Rotates an API key (creates new, revokes old)
   */
  @Post(':apiKeyId/rotate')
  @HttpCode(HttpStatus.OK)
  async rotateApiKey(
    @Param('apiKeyId') apiKeyId: string,
    @Body() body: { name?: string },
  ) {
    const result = await this.apiKeyService.rotateApiKey({
      apiKeyId,
      name: body.name,
    });

    return {
      apiKey: {
        id: result.apiKey.id,
        name: result.apiKey.name,
        keyPrefix: result.apiKey.keyPrefix,
        lastFour: result.apiKey.lastFour,
        status: result.apiKey.status,
        createdAt: result.apiKey.createdAt,
      },
      // WARNING: This is the only time the new plain text key is returned!
      plainTextKey: result.plainTextKey,
    };
  }
}
