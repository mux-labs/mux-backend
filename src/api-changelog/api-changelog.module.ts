import { Module } from '@nestjs/common';
import { ApiChangelogService } from './api-changelog.service';
import { ApiChangelogController } from './api-changelog.controller';

@Module({
  controllers: [ApiChangelogController],
  providers: [ApiChangelogService],
  exports: [ApiChangelogService],
})
export class ApiChangelogModule {}
