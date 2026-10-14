import { Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/**
 * EncryptionModule
 *
 * Provides the single controlled encryption/decryption path used by the
 * custody layer. Exported so wallet and transaction services can encrypt key
 * material without reimplementing the envelope.
 */
@Module({
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
