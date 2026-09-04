import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../encryption/encryption.service';

export interface WalletKeyReEncryptionResult {
  /** Wallet rows inspected in this run. */
  scanned: number;
  /** Wallets whose ciphertext was re-wrapped under the current key. */
  reEncrypted: number;
  /** Wallets already readable under the current key (no write performed). */
  alreadyCurrent: number;
  /** Wallets that could not be decrypted with the current or previous key. */
  failed: number;
}

export interface WalletKeyReEncryptionOptions {
  /** Rows fetched per database page (default 100, max 1000). */
  batchSize?: number;
  /** Safety cap on the total number of wallets processed in one run. */
  maxWallets?: number;
}

/**
 * Re-encrypts stored wallet key material after a `WALLET_ENCRYPTION_KEY`
 * (master key) rotation (issue #693).
 *
 * Operational flow:
 *   1. Deploy the new key as `WALLET_ENCRYPTION_KEY` and the old key as
 *      `WALLET_ENCRYPTION_KEY_PREVIOUS`.
 *   2. Invoke the internal endpoint — a single run walks every wallet using a
 *      stable id cursor, so it does not need to be called repeatedly.
 *   3. Once a run reports `reEncrypted=0` and `failed=0`, remove
 *      `WALLET_ENCRYPTION_KEY_PREVIOUS`.
 *
 * The job is idempotent: wallets already decryptable with the current key are
 * counted as `alreadyCurrent` and left untouched.
 */
@Injectable()
export class WalletKeyReEncryptionService {
  private readonly logger = new Logger(WalletKeyReEncryptionService.name);

  private static readonly DEFAULT_BATCH_SIZE = 100;
  private static readonly MAX_BATCH_SIZE = 1000;
  private static readonly DEFAULT_MAX_WALLETS = 50_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async reEncryptWallets(
    options: WalletKeyReEncryptionOptions = {},
    requestId?: string,
  ): Promise<WalletKeyReEncryptionResult> {
    if (!this.encryptionService.hasPreviousKey()) {
      throw new BadRequestException(
        'WALLET_ENCRYPTION_KEY_PREVIOUS is not configured — set the prior key ' +
          'before running the wallet key re-encryption job',
      );
    }

    const batchSize = Math.min(
      Math.max(
        options.batchSize ?? WalletKeyReEncryptionService.DEFAULT_BATCH_SIZE,
        1,
      ),
      WalletKeyReEncryptionService.MAX_BATCH_SIZE,
    );
    const maxWallets =
      options.maxWallets ?? WalletKeyReEncryptionService.DEFAULT_MAX_WALLETS;

    const result: WalletKeyReEncryptionResult = {
      scanned: 0,
      reEncrypted: 0,
      alreadyCurrent: 0,
      failed: 0,
    };

    let cursor: string | undefined;

    while (result.scanned < maxWallets) {
      const wallets = await this.prisma.wallet.findMany({
        take: batchSize,
        orderBy: { id: 'asc' },
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });

      if (wallets.length === 0) {
        break;
      }

      for (const wallet of wallets) {
        result.scanned += 1;
        try {
          const { data, rotated } =
            this.encryptionService.reEncryptWithCurrentKey(
              wallet.encryptedSecret,
            );

          if (!rotated) {
            result.alreadyCurrent += 1;
            continue;
          }

          await this.prisma.wallet.update({
            where: { id: wallet.id },
            data: {
              encryptedSecret: data,
              secretVersion: { increment: 1 },
            },
          });
          result.reEncrypted += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.error(
            `Failed to re-encrypt key material for wallet ${wallet.id}` +
              (requestId ? ` [requestId=${requestId}]` : ''),
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      cursor = wallets[wallets.length - 1].id;

      if (wallets.length < batchSize) {
        break;
      }
    }

    this.logger.log(
      `Wallet key re-encryption run complete` +
        (requestId ? ` [requestId=${requestId}]` : '') +
        ` scanned=${result.scanned} reEncrypted=${result.reEncrypted}` +
        ` alreadyCurrent=${result.alreadyCurrent} failed=${result.failed}`,
    );

    return result;
  }
}
