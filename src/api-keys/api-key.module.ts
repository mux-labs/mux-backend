import { Module } from '@nestjs/common';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyGuard } from './api-key.guard';

/**
 * API key module (#942/#943).
 *
 * Provides the key lifecycle (create/validate/revoke) and the guard that every
 * protected surface uses. Exported so feature modules can import it instead of
 * re-declaring their own `ApiKeyService` provider.
 */
@Module({
  imports: [ConfigModule],
  controllers: [ApiKeyController],
  providers: [ApiKeyService, ApiKeyGuard],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class ApiKeyModule {}
