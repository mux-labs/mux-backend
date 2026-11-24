import {
  WalletCreationOrchestrator,
  WalletOrchestrationError,
  type WalletCreationStore,
  type WalletOrchestrationResult,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';
import { EncryptionService } from '../encryption/encryption.service';

describe('WalletCreationOrchestrator.mint regression (#1311)', () => {
  const encryption = {
    encrypt: jest.fn(() => ({
      encryptedData: 'ciphertext',
      iv: 'iv',
      tag: 'tag',
    })),
  } as unknown as EncryptionService;

  const buildStore = (saveImpl?: jest.Mock): WalletCreationStore =>
    ({
      findByNaturalKey: jest.fn().mockResolvedValue(undefined),
      findIdempotency: jest.fn().mockResolvedValue(undefined),
      save: saveImpl ?? jest.fn().mockResolvedValue(undefined),
    }) as unknown as WalletCreationStore;

  it('generates and persists a wallet asynchronously, naming failures by phase', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const store = buildStore(save);
    const orchestrator = new WalletCreationOrchestrator(
      encryption,
      undefined,
      store,
    );

    const minted: Promise<WalletOrchestrationResult> = (
      orchestrator as any
    ).mint('user-1', WalletNetwork.TESTNET, 'key-mint');
    expect(minted).toBeInstanceOf(Promise);

    const result = await minted;
    expect(result.isNewWallet).toBe(true);
    expect(result.idempotencyKey).toBe('key-mint');
    expect(result.wallet.userId).toBe('user-1');
    expect(result.wallet.network).toBe(WalletNetwork.TESTNET);
    expect(result.wallet.status).toBe(WalletStatus.ACTIVE);
    expect(result.wallet.publicKey).toMatch(/^G/);
    expect(result.wallet.encryptedSecret).toEqual({
      encryptedData: 'ciphertext',
      iv: 'iv',
      tag: 'tag',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(result.wallet, 'key-mint');

    // Keygen and persistence failures are distinguishable by typed phase.
    const keygenOrchestrator = new WalletCreationOrchestrator(
      {
        encrypt: () => {
          throw new Error('entropy unavailable');
        },
      } as unknown as EncryptionService,
      undefined,
      buildStore(),
    );
    await expect(
      (keygenOrchestrator as any).mint('user-1', WalletNetwork.TESTNET),
    ).rejects.toMatchObject({ phase: 'keygen' });

    const persistOrchestrator = new WalletCreationOrchestrator(
      encryption,
      undefined,
      buildStore(jest.fn().mockRejectedValue(new Error('db down'))),
    );
    await expect(
      (persistOrchestrator as any).mint('user-1', WalletNetwork.TESTNET),
    ).rejects.toBeInstanceOf(WalletOrchestrationError);
    await expect(
      (persistOrchestrator as any).mint('user-1', WalletNetwork.TESTNET),
    ).rejects.toMatchObject({ phase: 'persist' });
  });
});
