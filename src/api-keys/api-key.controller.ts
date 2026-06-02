import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Delete,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiKeyService,
  CreateApiKeyRequest,
  ListApiKeysRequest,
} from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * Creates a new API key for a project
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createApiKey(@Body() request: CreateApiKeyDto) {
    const result = await this.apiKeyService.createApiKey(request as CreateApiKeyRequest);

    return {
      message: 'Store this key securely — it will not be shown again',
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
   * Lists all API keys for a project with pagination
   */
  @Get()
  async listApiKeys(
    @Query('projectId') projectId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('developerId') developerId?: string,
  ) {
    const result = await this.apiKeyService.listApiKeys({
      projectId,
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 10,
      developerId,
    });

    return {
      keys: result.keys.map((key) => ({
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        lastFour: key.lastFour,
        status: key.status,
        lastUsedAt: key.lastUsedAt,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        projectId: key.projectId,
      })),
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: Math.ceil(result.total / result.pageSize),
      },
    };
  }

  /**
   * Revokes an API key (idempotent)
   */
  @Post(':apiKeyId/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeApiKey(
    @Param('apiKeyId') apiKeyId: string,
    @Body() body: { reason?: string; developerId?: string },
  ) {
    const apiKey = await this.apiKeyService.revokeApiKey(
      apiKeyId,
      body.reason,
      body.developerId,
    );

    return {
      id: apiKey.id,
      status: apiKey.status,
      revokedAt: apiKey.revokedAt,
      revokedReason: apiKey.revokedReason,
    };
  }

  /**
   * Rotates an API key (creates new, marks old with grace period)
   */
  @Post(':apiKeyId/rotate')
  @HttpCode(HttpStatus.OK)
  async rotateApiKey(
    @Param('apiKeyId') apiKeyId: string,
    @Body() body: { name?: string; developerId?: string },
  ) {
    const result = await this.apiKeyService.rotateApiKey(
      {
        apiKeyId,
        name: body.name,
      },
      body.developerId,
    );

    return {
      message: 'Store this key securely — it will not be shown again',
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
