import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ApiChangelogService } from './api-changelog.service';
import { CreateApiChangelogDto } from './dto/create-api-changelog.dto';
import { ApiChangelogResponseDto } from './dto/api-changelog-response.dto';
import { RequireApiKey } from '../api-keys/decorators/require-api-key.decorator';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@ApiTags('api-changelog')
@ApiSecurity('api-key')
@Controller('api-changelog')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class ApiChangelogController {
  constructor(private readonly changelogService: ApiChangelogService) {}

  @RequireApiKey()
  @ApiOperation({ summary: 'Publish a new API changelog entry' })
  @ApiResponse({
    status: 201,
    description: 'Changelog entry published successfully',
    type: ApiChangelogResponseDto,
  })
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateApiChangelogDto) {
    return this.changelogService.create(dto);
  }

  @ApiOperation({ summary: 'List API changelog entries' })
  @ApiResponse({
    status: 200,
    description: 'Changelog entries retrieved',
    schema: {
      type: 'object',
      properties: {
        data: {
          type: 'array',
          items: { $ref: '#/components/schemas/ApiChangelogResponseDto' },
        },
        total: { type: 'number' },
      },
    },
  })
  @ApiQuery({
    name: 'version',
    required: false,
    description: 'Filter by API version (e.g., 1.2.0)',
  })
  @ApiQuery({
    name: 'category',
    required: false,
    description: 'Filter by change category',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max records to return (default 20, max 100)',
    example: 20,
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    description: 'Number of records to skip (default 0)',
    example: 0,
  })
  @Get()
  findAll(
    @Query('version') version?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.changelogService.findAll({
      version,
      category,
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });
  }

  @ApiOperation({ summary: 'Get a specific changelog entry' })
  @ApiResponse({
    status: 200,
    description: 'Changelog entry retrieved',
    type: ApiChangelogResponseDto,
  })
  @ApiParam({ name: 'id', description: 'Changelog entry ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.changelogService.findOne(id);
  }

  @RequireApiKey()
  @ApiOperation({ summary: 'Update a changelog entry' })
  @ApiResponse({
    status: 200,
    description: 'Changelog entry updated',
    type: ApiChangelogResponseDto,
  })
  @ApiParam({ name: 'id', description: 'Changelog entry ID' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: Partial<CreateApiChangelogDto>) {
    return this.changelogService.update(id, dto);
  }

  @RequireApiKey()
  @ApiOperation({ summary: 'Delete a changelog entry' })
  @ApiResponse({ status: 204, description: 'Changelog entry deleted' })
  @ApiParam({ name: 'id', description: 'Changelog entry ID' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  delete(@Param('id') id: string) {
    return this.changelogService.delete(id);
  }
}
