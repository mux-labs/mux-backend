/**
 * #693 — wallet key re-encryption job after a WALLET_ENCRYPTION_KEY rotation.
 */
import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptionService } from '../encryption/encryption.service';

// Prevent loading the real PrismaService (needs the generated Prisma client).
jest.mock('../prisma/prisma.service', () => ({ PrismaService: jest.fn() }));

import { PrismaService } from '../prisma/prisma.service';
import { WalletKeyReEncryptionService } from './wallet-key-reencryption.service';

const OLD_KEY = 'old-wallet-encryption-key-32-chars-long!!';
const NEW_KEY = 'new-wallet-encryption-key-32-chars-long!!';

const encryptionServiceFor = (current: string, previous?: string) => {
  const cfg = {
    get: jest.fn((key: string) =>
      key === 'WALLET_ENCRYPTION_KEY_PREVIOUS' ? previous : current,
    ),
  } as unknown as ConfigService;
  return new EncryptionService(cfg);
};

describe('WalletKeyReEncryptionService', () => {
  const makePrisma = (
    wallets: Array<{ id: string; encryptedSecret: string }>,
  ) => {
    const store = [...wallets];
    return {
      wallet: {
        findMany: jest.fn(({ take, cursor, skip }: any) => {
          let start = 0;
          if (cursor) {
            start = store.findIndex((w) => w.id === cursor.id) + (skip ?? 0);
          }
          return Promise.resolve(store.slice(start, start + take));
        }),
        update: jest.fn(({ where, data }: any) => {
          const row = store.find((w) => w.id === where.id);
          if (row && typeof data.encryptedSecret === 'string') {
            row.encryptedSecret = data.encryptedSecret;
          }
          return Promise.resolve(row);
        }),
      },
      _store: store,
    };
  };

  it('rejects the run when no previous key is configured', async () => {
    const prisma = makePrisma([]);
    const service = new WalletKeyReEncryptionService(
      prisma as unknown as PrismaService,
      encryptionServiceFor(NEW_KEY),
    );

    await expect(service.reEncryptWallets()).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.wallet.findMany).not.toHaveBeenCalled();
  });

  it('re-encrypts wallets stored under the previous key and leaves current ones alone', async () => {
    const oldEnc = encryptionServiceFor(OLD_KEY);
    const newEnc = encryptionServiceFor(NEW_KEY);
    const rotating = encryptionServiceFor(NEW_KEY, OLD_KEY);

    const prisma = makePrisma([
      { id: 'w1', encryptedSecret: oldEnc.encryptAndSerialize('seed-1') },
      { id: 'w2', encryptedSecret: newEnc.encryptAndSerialize('seed-2') },
      { id: 'w3', encryptedSecret: oldEnc.encryptAndSerialize('seed-3') },
    ]);

    const service = new WalletKeyReEncryptionService(
      prisma as unknown as PrismaService,
      rotating,
    );

    const result = await service.reEncryptWallets({ batchSize: 2 });

    expect(result).toEqual({
      scanned: 3,
      reEncrypted: 2,
      alreadyCurrent: 1,
      failed: 0,
    });
    expect(prisma.wallet.update).toHaveBeenCalledTimes(2);
    // Every wallet is now readable with the new key alone.
    for (const row of prisma._store) {
      expect(newEnc.deserializeAndDecrypt(row.encryptedSecret)).toMatch(
        /^seed-/,
      );
    }
  });

  it('is idempotent — a second run re-encrypts nothing', async () => {
    const oldEnc = encryptionServiceFor(OLD_KEY);
    const rotating = encryptionServiceFor(NEW_KEY, OLD_KEY);
    const prisma = makePrisma([
      { id: 'w1', encryptedSecret: oldEnc.encryptAndSerialize('seed-1') },
    ]);
    const service = new WalletKeyReEncryptionService(
      prisma as unknown as PrismaService,
      rotating,
    );

    await service.reEncryptWallets();
    const second = await service.reEncryptWallets();

    expect(second).toEqual({
      scanned: 1,
      reEncrypted: 0,
      alreadyCurrent: 1,
      failed: 0,
    });
  });

  it('counts wallets that cannot be decrypted with either key as failed', async () => {
    const rotating = encryptionServiceFor(NEW_KEY, OLD_KEY);
    const stranger = encryptionServiceFor(
      'unrelated-key-32-characters-long!!!!!',
    );
    const prisma = makePrisma([
      { id: 'w1', encryptedSecret: stranger.encryptAndSerialize('seed-1') },
    ]);
    const service = new WalletKeyReEncryptionService(
      prisma as unknown as PrismaService,
      rotating,
    );

    const result = await service.reEncryptWallets();

    expect(result.failed).toBe(1);
    expect(result.reEncrypted).toBe(0);
    expect(prisma.wallet.update).not.toHaveBeenCalled();
  });
});
