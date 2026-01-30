import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';
import { ApiKeyGuard } from './api-key.guard';

@Module({
  controllers: [ApiKeyController],
  providers: [
    ApiKeyService,
    ApiKeyGuard,
  ],
  exports: [ApiKeyService, ApiKeyGuard],
})
export class ApiKeyModule {}
