import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EncryptionService } from './encryption.service';

/**
 * EncryptionModule
 *
 * Provides the single controlled encryption/decryption path used by the
 * custody layer. Exported so wallet and transaction services can encrypt key
 * material without reimplementing the envelope.
 *
 * Imports `ConfigModule` because `EncryptionService` is fail-closed on the
 * master key: it reads `WALLET_ENCRYPTION_KEY` from config and refuses to
 * construct without a valid value.
 */
@Module({
  imports: [ConfigModule],
  providers: [EncryptionService],
  exports: [EncryptionService],
})
export class EncryptionModule {}
