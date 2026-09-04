import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import {
  ApiKeyService,
  CreateApiKeyRequest,
  ListApiKeysRequest,
} from './api-key.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

@ApiTags('api-keys')
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  /**
   * Creates a new API key for a project
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new API key',
    description:
      'Generates a new API key for a project. The plain-text key is returned **only once** — store it securely.',
  })
  @ApiBody({
    type: CreateApiKeyDto,
    examples: {
      basic: {
        summary: 'Basic key creation',
        value: { name: 'production-key', projectId: 'project-abc123' },
      },
      withExpiry: {
        summary: 'Key with expiration date',
        value: {
          name: 'temporary-key',
          projectId: 'project-abc123',
          expiresAt: '2027-01-01T00:00:00.000Z',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'API key created — plain-text key returned only here.',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Store this key securely — it will not be shown again',
        },
        apiKey: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'apikey-uuid-here' },
            name: { type: 'string', example: 'production-key' },
            keyPrefix: { type: 'string', example: 'mux_live_' },
            lastFour: { type: 'string', example: 'Ab1C' },
            status: { type: 'string', example: 'ACTIVE' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        plainTextKey: {
          type: 'string',
          example: 'mux_live_AbCdEfGhIjKlMnOpQrStUvWx',
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Bad request — missing or invalid fields.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 400 },
        message: { type: 'array', items: { type: 'string' } },
        error: { type: 'string', example: 'Bad Request' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Project not found.',
    schema: {
      type: 'object',
      properties: {
        statusCode: { type: 'number', example: 404 },
        message: { type: 'string', example: 'Project project-abc123 not found' },
      },
    },
  })
  async createApiKey(@Body() request: CreateApiKeyDto) {
    const result = await this.apiKeyService.createApiKey(
      request as CreateApiKeyRequest,
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
      // WARNING: This is the only time the plain text key is returned!
      plainTextKey: result.plainTextKey,
    };
  }

  /**
   * Lists all API keys for a project with pagination
   */
  @Get()
  @ApiOperation({
    summary: 'List API keys for a project',
    description: 'Returns paginated API key metadata. Plain-text keys are never exposed here.',
  })
  @ApiQuery({ name: 'projectId', required: true, description: 'Project ID to list keys for', example: 'project-abc123' })
  @ApiQuery({ name: 'page', required: false, description: 'Page number (1-based)', example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, description: 'Number of results per page', example: 10 })
  @ApiQuery({ name: 'developerId', required: false, description: 'Optional developer ID for ownership check' })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of API key metadata.',
    schema: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', example: 'apikey-uuid-here' },
              name: { type: 'string', example: 'production-key' },
              keyPrefix: { type: 'string', example: 'mux_live_' },
              lastFour: { type: 'string', example: 'Ab1C' },
              status: { type: 'string', example: 'ACTIVE' },
              lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
              createdAt: { type: 'string', format: 'date-time' },
              expiresAt: { type: 'string', format: 'date-time', nullable: true },
              projectId: { type: 'string', example: 'project-abc123' },
            },
          },
        },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'number', example: 1 },
            pageSize: { type: 'number', example: 10 },
            total: { type: 'number', example: 42 },
            totalPages: { type: 'number', example: 5 },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Unauthorized — developer does not own this project.',
  })
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
  @ApiOperation({
    summary: 'Revoke an API key',
    description: 'Marks the key as REVOKED. Idempotent — revoking an already-revoked key succeeds.',
  })
  @ApiParam({ name: 'apiKeyId', description: 'ID of the API key to revoke', example: 'apikey-uuid-here' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', example: 'Key compromised', description: 'Optional revocation reason' },
        developerId: { type: 'string', example: 'dev-uuid', description: 'Optional: verify ownership before revoking' },
      },
    },
    examples: {
      basic: { summary: 'Revoke without reason', value: {} },
      withReason: { summary: 'Revoke with reason', value: { reason: 'Key compromised during security incident' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'API key revoked successfully.',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', example: 'apikey-uuid-here' },
        status: { type: 'string', example: 'REVOKED' },
        revokedAt: { type: 'string', format: 'date-time' },
        revokedReason: { type: 'string', nullable: true, example: 'Key compromised' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Not authorized to revoke this key.' })
  @ApiResponse({ status: 404, description: 'API key not found.' })
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
  @ApiOperation({
    summary: 'Rotate an API key',
    description:
      'Creates a new API key and sets the old key into a grace-period window (configurable via `API_KEY_ROTATION_GRACE_SECONDS`). ' +
      'Both keys remain valid during the grace period so clients can migrate without downtime.',
  })
  @ApiParam({ name: 'apiKeyId', description: 'ID of the API key to rotate', example: 'apikey-uuid-here' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', example: 'production-key-v2', description: 'Optional name for the new key' },
        developerId: { type: 'string', example: 'dev-uuid', description: 'Optional: verify ownership before rotating' },
      },
    },
    examples: {
      basic: { summary: 'Rotate without renaming', value: {} },
      withName: { summary: 'Rotate with new name', value: { name: 'production-key-v2' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'New API key returned. Old key stays valid during the grace period.',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Store this key securely — it will not be shown again' },
        apiKey: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'apikey-new-uuid' },
            name: { type: 'string', example: 'production-key-v2' },
            keyPrefix: { type: 'string', example: 'mux_live_' },
            lastFour: { type: 'string', example: 'Xy9Z' },
            status: { type: 'string', example: 'ACTIVE' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        plainTextKey: { type: 'string', example: 'mux_live_XyZaBcDeFgHiJkLmNoPqRsTuV' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Not authorized to rotate this key.' })
  @ApiResponse({ status: 404, description: 'API key not found.' })
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
