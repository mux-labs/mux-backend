import { Module } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { StrKeyHelper } from './utils/strkey.helper';

@Module({
  providers: [KeyManagementService, StrKeyHelper],
  exports: [KeyManagementService, StrKeyHelper],
})
export class KeyManagementModule {}
