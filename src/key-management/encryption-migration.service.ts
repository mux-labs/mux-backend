import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KeyManagementService } from './key-management.service';
import { KeyType } from './domain/key-types';

/** Encryption envelope version wallets are migrated to. Matches
 * KeyManagementService.reEncryptKey's target envelope version. */
export const CURRENT_ENCRYPTION_VERSION = 2;

export interface EncryptionMigrationResult {
  scanned: number;
  migrated: number;
  failed: number;
}

/**
 * Upgrades stored wallet ciphertext for wallets whose encryptionVersion is
 * behind CURRENT_ENCRYPTION_VERSION. Decrypts with the wallet's existing
 * envelope and re-encrypts with the current one via KeyManagementService.
 */
@Injectable()
export class EncryptionMigrationService {
  private readonly logger = new Logger(EncryptionMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyManagementService: KeyManagementService,
  ) {}

  async migrateEncryptionVersions(
    batchSize = 50,
  ): Promise<EncryptionMigrationResult> {
    const wallets = await this.prisma.wallet.findMany({
      where: { encryptionVersion: { lt: CURRENT_ENCRYPTION_VERSION } },
      take: batchSize,
    });

    const result: EncryptionMigrationResult = {
      scanned: wallets.length,
      migrated: 0,
      failed: 0,
    };

    for (const wallet of wallets) {
      try {
        const reEncrypted = await this.keyManagementService.reEncryptKey(
          wallet.encryptedSecret,
          KeyType.STELLAR_ED25519,
          wallet.id,
        );
        await this.prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            encryptedSecret: reEncrypted.encryptedData,
            encryptionVersion: reEncrypted.encryptionVersion,
          },
        });
        result.migrated += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Failed to migrate encryption version for wallet ${wallet.id}`,
          error,
        );
      }
    }

    this.logger.log(
      `Encryption migration batch complete: scanned=${result.scanned} migrated=${result.migrated} failed=${result.failed}`,
    );
    return result;
  }
}
