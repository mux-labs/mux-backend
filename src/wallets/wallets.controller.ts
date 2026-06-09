import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiParam } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';
import { RequireApiKey } from '../api-keys/decorators/require-api-key.decorator';
import { ApiKeyCtx } from '../api-keys/decorators/api-key-context.decorator';
import type { ApiKeyContext } from '../api-keys/domain/api-key.model';
import { ApiKeyGuard } from '../api-keys/api-key.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';

@ApiTags('wallets')
@ApiSecurity('api-key')
@Controller('wallets')
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @ApiOperation({ summary: 'Create a new wallet' })
  @Post()
  create(@Body() createWalletDto: CreateWalletDto) {
    return this.walletsService.create(createWalletDto);
  }

  @ApiOperation({ summary: 'List all wallets' })
  @Get()
  findAll() {
    return this.walletsService.findAll();
  }

  @RequireApiKey()
  @Get('protected')
  async protectedEndpoint(@ApiKeyCtx() context: ApiKeyContext) {
    // context contains developer, project, and apiKey info
    return {
      message: 'This endpoint is protected by API key',
      developer: context.developer.email,
      project: context.project.name,
    };
  }

  // #185: Expose wallet status endpoint
  @Get(':id/status')
  async getWalletStatus(@Param('id') id: string) {
    return this.walletsService.getWalletStatus(id);
  }

  // #188: Activate wallet (PROVISIONING -> ACTIVE)
  @Patch(':id/activate')
  async activateWallet(@Param('id') id: string) {
    return this.walletsService.activateWallet(id);
  }

  // #189: List wallets by userId
  @Get('user/:userId')
  async findByUserId(@Param('userId') userId: string) {
    return this.walletsService.findWalletsByUserId(userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.walletsService.findOne(id);
  }

  @ApiOperation({ summary: 'Update a wallet' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateWalletDto: UpdateWalletDto) {
    return this.walletsService.update(id, updateWalletDto);
  }

  @ApiOperation({ summary: 'Delete a wallet' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.walletsService.remove(id);
  }
}
