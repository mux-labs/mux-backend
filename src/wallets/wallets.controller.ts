import { Controller, Get } from '@nestjs/common';
import { WalletsService } from './wallets.service';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  /**
   * Protected endpoint - requires API key (enforced by global ApiKeyGuard).
   * Returns list of wallets.
   */
  @Get()
  async findAll() {
    return this.walletsService.findAll();
  }

  /**
   * Another protected endpoint for testing.
   */
  @Get('protected')
  async protected() {
    return { message: 'Protected endpoint accessed', timestamp: new Date().toISOString() };
  }
}