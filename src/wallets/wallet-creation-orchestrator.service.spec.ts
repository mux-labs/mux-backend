import { ConflictException } from '@nestjs/common';
import {
  WalletCreationOrchestrator,
  WalletOrchestrationError,
  type CreateWalletOrchestratorRequest,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';

/**
 * Retry / replay contract for wallet orchestration (#963).
 *
 * The external orchestrator retries on failure. A retry that minted a second
 * custody key for the same user would strand funds on an orphaned address, so
 * these tests pin the three guards that prevent it:
 *   1. idempotency-key replay returns the original result verbatim
 *   2. an in-flight key is not processed twice concurrently
 *   3. one wallet per (userId, network) even with no key
 */
describe('WalletCreationOrchestrator', () => {
  let orchestrator: WalletCreationOrchestrator;

  beforeEach(() => {
    orchestrator = new WalletCreationOrchestrator();
  });

  const req = (
    overrides: Partial<CreateWalletOrchestratorRequest> = {},
  ): CreateWalletOrchestratorRequest => ({
    userId: 'user-1',
    network: WalletNetwork.TESTNET,
    ...overrides,
  });

  describe('first creation', () => {
    it('creates a wallet and reports isNewWallet=true', async () => {
      const result = await orchestrator.createWallet(req());

      expect(result.isNewWallet).toBe(true);
      expect(result.wallet.userId).toBe('user-1');
      expect(result.wallet.network).toBe(WalletNetwork.TESTNET);
      expect(result.wallet.status).toBe(WalletStatus.ACTIVE);
      expect(result.wallet.publicKey).toMatch(/^G/);
    });

    it('never returns private key material to the caller', async () => {
      // The custody secret must not cross the service boundary at all.
      const result = await orchestrator.createWallet(req());
      const serialized = JSON.stringify(result);

      expect(serialized).not.toMatch(/privateKey/i);
      expect(serialized).not.toMatch(/secret/i);
    });

    it('echoes the supplied idempotencyKey', async () => {
      const result = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );
      expect(result.idempotencyKey).toBe('key-alpha');
    });
  });

  describe('guard 1 — idempotency-key replay (retry after dropped response)', () => {
    it('replays the identical wallet on retry', async () => {
      const first = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );
      const retry = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );

      // Same wallet id — a retry must NOT mint a second custody key.
      expect(retry.wallet.id).toBe(first.wallet.id);
      expect(retry.wallet.publicKey).toBe(first.wallet.publicKey);
    });

    it('replays the original isNewWallet flag verbatim', async () => {
      const first = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );
      const retry = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );

      // The caller must still be able to tell this was the original creation,
      // not have it silently rewritten to false.
      expect(retry.isNewWallet).toBe(first.isNewWallet);
      expect(retry.isNewWallet).toBe(true);
    });

    it('replays the original createdAt, not a fresh timestamp', async () => {
      const first = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );
      const retry = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );

      expect(retry.wallet.createdAt.getTime()).toBe(
        first.wallet.createdAt.getTime(),
      );
    });

    it('stays stable across many retries', async () => {
      const first = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-alpha' }),
      );
      for (let i = 0; i < 5; i++) {
        const retry = await orchestrator.createWallet(
          req({ idempotencyKey: 'key-alpha' }),
        );
        expect(retry.wallet.id).toBe(first.wallet.id);
      }
    });

    it('rejects reuse of a key for a different user', async () => {
      await orchestrator.createWallet(
        req({ userId: 'user-1', idempotencyKey: 'key-alpha' }),
      );

      // Silently returning user-1's wallet to a request for user-2 would be a
      // cross-tenant leak; this must be a conflict, not a wrong answer.
      await expect(
        orchestrator.createWallet(
          req({ userId: 'user-2', idempotencyKey: 'key-alpha' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects reuse of a key on a different network', async () => {
      await orchestrator.createWallet(
        req({ network: WalletNetwork.TESTNET, idempotencyKey: 'key-alpha' }),
      );

      await expect(
        orchestrator.createWallet(
          req({ network: WalletNetwork.MAINNET, idempotencyKey: 'key-alpha' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('uses a stable error code on key conflict', async () => {
      await orchestrator.createWallet(
        req({ userId: 'user-1', idempotencyKey: 'key-alpha' }),
      );

      await expect(
        orchestrator.createWallet(
          req({ userId: 'user-2', idempotencyKey: 'key-alpha' }),
        ),
      ).rejects.toMatchObject({
        response: { code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT' },
      });
    });
  });

  describe('guard 2 — concurrent retries with the same key', () => {
    it('rejects a concurrent retry instead of minting a second wallet', async () => {
      // Gate the private persistence step so the first call is deterministically
      // still in flight when the second arrives.
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const mintSpy = jest
        .spyOn(orchestrator as never, 'mint')
        .mockImplementation(async () => {
          await gate;
          return {
            id: 'wallet-1',
            userId: 'user-1',
            publicKey: 'Gstub',
            network: WalletNetwork.TESTNET,
            status: WalletStatus.ACTIVE,
            createdAt: new Date(),
          };
        });

      const first = orchestrator.createWallet(
        req({ idempotencyKey: 'key-concurrent' }),
      );
      // Let the first call reach its await inside mint().
      await new Promise((r) => setImmediate(r));

      await expect(
        orchestrator.createWallet(req({ idempotencyKey: 'key-concurrent' })),
      ).rejects.toMatchObject({
        response: { code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_IN_PROGRESS' },
      });

      release();
      await expect(first).resolves.toMatchObject({ isNewWallet: true });
      mintSpy.mockRestore();
    });

    it('releases the in-flight reservation so a later retry still succeeds', async () => {
      await orchestrator.createWallet(req({ idempotencyKey: 'key-release' }));
      // If the reservation leaked, this would reject forever.
      await expect(
        orchestrator.createWallet(req({ idempotencyKey: 'key-release' })),
      ).resolves.toBeDefined();
    });

    it('does not leak reservations when a call fails', async () => {
      const failing = jest
        .spyOn(orchestrator as never, 'mint')
        .mockImplementation(() => {
          throw new WalletOrchestrationError('boom', 'persist');
        });

      await expect(
        orchestrator.createWallet(req({ idempotencyKey: 'key-fail' })),
      ).rejects.toBeInstanceOf(WalletOrchestrationError);

      failing.mockRestore();
      // The key must be reusable after the failure, or one transient error
      // would poison the key forever.
      await expect(
        orchestrator.createWallet(req({ idempotencyKey: 'key-fail' })),
      ).resolves.toBeDefined();
    });
  });

  describe('guard 3 — one wallet per (userId, network)', () => {
    it('returns the existing wallet instead of creating a second', async () => {
      const first = await orchestrator.createWallet(req());
      const second = await orchestrator.createWallet(req());

      expect(second.wallet.id).toBe(first.wallet.id);
      expect(second.isNewWallet).toBe(false);
    });

    it('scopes wallets per network', async () => {
      const testnet = await orchestrator.createWallet(
        req({ network: WalletNetwork.TESTNET }),
      );
      const mainnet = await orchestrator.createWallet(
        req({ network: WalletNetwork.MAINNET }),
      );

      // Different networks are legitimately different wallets.
      expect(mainnet.wallet.id).not.toBe(testnet.wallet.id);
    });

    it('scopes wallets per user', async () => {
      const a = await orchestrator.createWallet(req({ userId: 'user-a' }));
      const b = await orchestrator.createWallet(req({ userId: 'user-b' }));

      expect(b.wallet.id).not.toBe(a.wallet.id);
    });

    it('does not let a no-key retry duplicate a keyed creation', async () => {
      const keyed = await orchestrator.createWallet(
        req({ idempotencyKey: 'key-x' }),
      );
      const unkeyed = await orchestrator.createWallet(req());

      // Mixed keyed/unkeyed retries of the same logical request.
      expect(unkeyed.wallet.id).toBe(keyed.wallet.id);
    });

    it('validateUserCanCreateWallet flips false after creation', async () => {
      await expect(
        orchestrator.validateUserCanCreateWallet(
          'user-1',
          WalletNetwork.TESTNET,
        ),
      ).resolves.toBe(true);

      await orchestrator.createWallet(req());

      await expect(
        orchestrator.validateUserCanCreateWallet(
          'user-1',
          WalletNetwork.TESTNET,
        ),
      ).resolves.toBe(false);
    });
  });

  describe('fail-closed on dependency outage', () => {
    it('surfaces a persistence failure with a typed phase', async () => {
      jest.spyOn(orchestrator as never, 'mint').mockImplementation(() => {
        throw new WalletOrchestrationError('down', 'persist');
      });

      await expect(orchestrator.createWallet(req())).rejects.toMatchObject({
        phase: 'persist',
      });
    });

    it('does not record a wallet when persistence fails', async () => {
      const spy = jest
        .spyOn(orchestrator as never, 'mint')
        .mockImplementation(() => {
          throw new WalletOrchestrationError('down', 'persist');
        });

      await expect(orchestrator.createWallet(req())).rejects.toBeDefined();
      spy.mockRestore();

      // No partial wallet may be left behind by a failed creation.
      await expect(
        orchestrator.getWalletByUser('user-1', WalletNetwork.TESTNET),
      ).resolves.toBeNull();
    });

    it('surfaces a keygen failure with a typed phase', async () => {
      jest.spyOn(global.Math, 'random').mockImplementation(() => {
        throw new Error('entropy unavailable');
      });

      // randomUUID uses the CSPRNG, so simulate at the mint boundary instead.
      const spy = jest
        .spyOn(orchestrator as never, 'mint')
        .mockImplementation(() => {
          throw new WalletOrchestrationError('down', 'keygen');
        });

      await expect(orchestrator.createWallet(req())).rejects.toMatchObject({
        phase: 'keygen',
      });
      spy.mockRestore();
      jest.spyOn(global.Math, 'random').mockRestore();
    });
  });

  describe('lookups', () => {
    it('getWalletByUser returns null for an unknown user', async () => {
      await expect(
        orchestrator.getWalletByUser('nobody', WalletNetwork.TESTNET),
      ).resolves.toBeNull();
    });

    it('getWalletByUser returns the wallet after creation', async () => {
      const created = await orchestrator.createWallet(req());
      await expect(
        orchestrator.getWalletByUser('user-1', WalletNetwork.TESTNET),
      ).resolves.toMatchObject({ id: created.wallet.id });
    });
  });
});
