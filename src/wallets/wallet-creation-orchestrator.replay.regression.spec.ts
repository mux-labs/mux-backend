import { ConflictException } from '@nestjs/common';
import {
  WalletCreationOrchestrator,
  type WalletCreationStore,
  type WalletOrchestrationResult,
} from './wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from './domain/wallet.model';

describe('WalletCreationOrchestrator.replayIfCompleted regression (#1310)', () => {
  const stored: WalletOrchestrationResult = {
    wallet: {
      id: 'wallet-1',
      userId: 'user-1',
      publicKey: 'GSTORED',
      encryptedSecret: 'enc:v1:stub',
      network: WalletNetwork.TESTNET,
      status: WalletStatus.ACTIVE,
      idempotencyKey: 'key-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    isNewWallet: true,
    idempotencyKey: 'key-1',
  };

  it('returns the stored result for a completed key, nullish for an unknown key, and conflicts on a changed owner', async () => {
    const findIdempotency = jest
      .fn()
      .mockResolvedValueOnce({ userId: 'user-1', network: WalletNetwork.TESTNET, result: stored })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ userId: 'user-1', network: WalletNetwork.TESTNET, result: stored })
      .mockResolvedValueOnce({ userId: 'user-1', network: WalletNetwork.TESTNET, result: stored });
    const store = { findIdempotency } as unknown as WalletCreationStore;
    const orchestrator = new WalletCreationOrchestrator(undefined, undefined, store);

    const replay = (orchestrator as any).replayIfCompleted(
      'key-1',
      'user-1',
      WalletNetwork.TESTNET,
    );
    // The method is async: callers must await the durable store lookup.
    expect(replay).toBeInstanceOf(Promise);
    await expect(replay).resolves.toBe(stored);

    const unknown = await (orchestrator as any).replayIfCompleted(
      'unknown',
      'user-1',
      WalletNetwork.TESTNET,
    );
    // Current implementation returns undefined; the contract is "no result".
    expect(unknown ?? null).toBeNull();

    await expect(
      (orchestrator as any).replayIfCompleted(
        'key-1',
        'user-2',
        WalletNetwork.TESTNET,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      (orchestrator as any).replayIfCompleted(
        'key-1',
        'user-1',
        WalletNetwork.MAINNET,
      ),
    ).rejects.toMatchObject({
      response: { code: 'WALLET_ORCHESTRATION_IDEMPOTENCY_CONFLICT' },
    });

    expect(findIdempotency).toHaveBeenCalledWith('key-1');
  });
});
