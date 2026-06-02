import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiSecurity } from '@nestjs/swagger';
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { UpdateWalletDto } from './dto/update-wallet.dto';

@ApiTags('wallets')
@ApiSecurity('api-key')
@Controller('wallets')
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

  @ApiOperation({ summary: 'Get a wallet by ID' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.walletsService.findOne(+id);
  }

  @ApiOperation({ summary: 'Update a wallet' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateWalletDto: UpdateWalletDto) {
    return this.walletsService.update(+id, updateWalletDto);
  }

  @ApiOperation({ summary: 'Delete a wallet' })
  @ApiParam({ name: 'id', description: 'Wallet ID' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.walletsService.remove(+id);
  }
}
