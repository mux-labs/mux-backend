import { HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalletCreationOrchestrator } from './wallet-creation-orchestrator.service';
import { WalletNetwork } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';
import {
  WalletSponsorshipLimitErrorCode,
  WALLET_SPONSORSHIP_ENABLED_ENV,
} from './wallet-sponsorship-limits';

/**
 * Enforcement coverage for the sponsored-wallet cap (#957).
 *
 * `wallet-sponsorship-limits.spec.ts` exercises the limiter in isolation, and
 * the `wallet-sponsorship-limits` CI job runs only that file. That is not
 * enough: the limiter can be perfect while nothing calls it. These tests drive
 * the real `createWallet` path, so removing the enforcement — or moving it to
 * the wrong side of the idempotency check — fails here.
 */
describe('WalletCreationOrchestrator — sponsorship limit enforcement (#957)', () => {
  const USER_ID = 'user-1';
  const PER_USER_ENV = 'WALLET_MAX_SPONSORED_WALLETS_PER_USER';

  let orchestrator: WalletCreationOrchestrator;
  let walletCreates: number;
  let idempotencyStore: Map<string, unknown>;

  const walletRow = (id: string, status: string) => ({
    id,
    userId: USER_ID,
    publicKey: 'GPUBLIC',
    network: WalletNetwork.TESTNET,
    status,
    encryptedSecret: 'enc',
    encryptionVersion: 1,
    secretVersion: 1,
    keyVersion: 1,
    nickname: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  /** Builds the orchestrator over an in-memory transaction fake. */
  function buildOrchestrator(): WalletCreationOrchestrator {
    walletCreates = 0;
    idempotencyStore = new Map();

    const tx = {
      wallet: {
        // No pre-existing wallet, so the creation path is reached.
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(() => {
          walletCreates += 1;
          return Promise.resolve(
            walletRow(`wallet-${walletCreates}`, 'PROVISIONING'),
          );
        }),
        update: jest
          .fn()
          .mockImplementation(({ where }: { where: { id: string } }) =>
            Promise.resolve(walletRow(where.id, 'ACTIVE')),
          ),
      },
      // In-memory idempotency store, so the replay guard is exercised for real
      // rather than stubbed away.
      idempotencyRecord: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: { where: { key: string } }) =>
            Promise.resolve(idempotencyStore.get(where.key) ?? null),
          ),
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            idempotencyStore.set(data.key as string, data);
            return Promise.resolve(data);
          }),
        delete: jest
          .fn()
          .mockImplementation(({ where }: { where: { key: string } }) => {
            idempotencyStore.delete(where.key);
            return Promise.resolve({});
          }),
        upsert: jest
          .fn()
          .mockImplementation(
            ({
              where,
              create,
            }: {
              where: { key: string };
              create: Record<string, unknown>;
            }) => {
              idempotencyStore.set(where.key, create);
              return Promise.resolve(create);
            },
          ),
      },
    };

    const prisma = {
      // Execute the transaction body against the fake tx, then "commit".
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
      $disconnect: jest.fn(),
    };

    return new WalletCreationOrchestrator(
      {
        validateConfiguration: jest.fn(() => true),
        deserializeAndDecrypt: jest.fn(() => 'S' + 'x'.repeat(55)),
      } as unknown as EncryptionService,
      new ConfigService({}),
      {
        findUserById: jest.fn().mockResolvedValue({
          id: USER_ID,
          authId: 'auth-1',
          authProvider: 'test',
          createdAt: new Date(),
        }),
      },
      {
        generateKey: jest.fn().mockResolvedValue({
          publicKey: 'GPUBLIC',
          encryptedData: 'enc',
          encryptionVersion: 1,
        }),
      },
      prisma as never,
    );
  }

  beforeEach(() => {
    delete process.env[PER_USER_ENV];
    delete process.env[WALLET_SPONSORSHIP_ENABLED_ENV];
    orchestrator = buildOrchestrator();
  });

  afterEach(() => {
    delete process.env[PER_USER_ENV];
    delete process.env[WALLET_SPONSORSHIP_ENABLED_ENV];
  });

  const request = (idempotencyKey?: string) => ({
    userId: USER_ID,
    network: WalletNetwork.TESTNET,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

  const codeOf = (err: unknown) =>
    (err as { response?: { code?: string } })?.response?.code;

  const statusOf = (err: unknown) => (err as { status?: number })?.status;

  it('allows a sponsored creation while the caller is under the cap', async () => {
    const result = await orchestrator.createWallet(request());

    expect(result.isNewWallet).toBe(true);
    expect(walletCreates).toBe(1);
  });

  it('refuses the creation once the per-user cap is reached, minting nothing', async () => {
    process.env[PER_USER_ENV] = '1';
    orchestrator = buildOrchestrator();

    // The first call consumes the single allowance.
    await orchestrator.createWallet(request('key-1'));

    // The second must be refused and must not mint a wallet.
    await expect(orchestrator.createWallet(request('key-2'))).rejects.toThrow(
      HttpException,
    );

    // Only the allowed call reached persistence.
    expect(walletCreates).toBe(1);
  });

  it('surfaces the stable per-user code on refusal', async () => {
    process.env[PER_USER_ENV] = '1';
    orchestrator = buildOrchestrator();

    await orchestrator.createWallet(request('key-1'));

    const error = await orchestrator
      .createWallet(request('key-2'))
      .catch((e: unknown) => e);

    expect(codeOf(error)).toBe(
      WalletSponsorshipLimitErrorCode.PER_USER_LIMIT_REACHED,
    );
    // A refused cap is a retryable policy decision, not a server fault: the
    // client must back off until the window rolls, not retry immediately.
    expect(statusOf(error)).toBe(HttpStatus.TOO_MANY_REQUESTS);
  });

  it('refuses every sponsored creation when the kill-switch is off', async () => {
    process.env[WALLET_SPONSORSHIP_ENABLED_ENV] = 'false';
    orchestrator = buildOrchestrator();

    const error = await orchestrator
      .createWallet(request())
      .catch((e: unknown) => e);

    expect(codeOf(error)).toBe(
      WalletSponsorshipLimitErrorCode.SPONSORSHIP_DISABLED,
    );
    expect(walletCreates).toBe(0);
  });

  it('does not spend the allowance when the request is an idempotency replay', async () => {
    process.env[PER_USER_ENV] = '2';
    orchestrator = buildOrchestrator();

    await orchestrator.createWallet(request('same-key'));

    // A replay must not consume a slot. With a cap of 2, a further distinct
    // key is still admitted, and a third would be refused — which is only
    // reachable if the replay spent nothing.
    await expect(
      orchestrator.createWallet(request('same-key')),
    ).resolves.toBeDefined();
    await expect(
      orchestrator.createWallet(request('other-key')),
    ).resolves.toBeDefined();

    expect(walletCreates).toBe(2);
  });

  it('refuses the third creation under a cap of two', async () => {
    process.env[PER_USER_ENV] = '2';
    orchestrator = buildOrchestrator();

    await orchestrator.createWallet(request('k1'));
    await orchestrator.createWallet(request('k2'));

    await expect(orchestrator.createWallet(request('k3'))).rejects.toThrow(
      HttpException,
    );
    expect(walletCreates).toBe(2);
  });
});
