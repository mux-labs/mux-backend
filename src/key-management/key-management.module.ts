import { Module } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { KeyManagementController } from './key-management.controller';
import { StellarKeyProvider } from './providers/stellar-key.provider';
import { EncryptionModule } from '../encryption/encryption.module';

@Module({
  imports: [EncryptionModule],
  controllers: [KeyManagementController],
  providers: [KeyManagementService, StellarKeyProvider],
  exports: [KeyManagementService],
})
export class KeyManagementModule {}
