import 'reflect-metadata';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import {
  CURRENT_KEY_VERSION,
  KeyRotationErrorCode,
  KEY_ROTATION_ENABLED_ENV,
  ROTATION_REPLAY_WINDOW_MS,
  SUPPORTED_KEY_VERSIONS,
} from './key-rotation.model';
import type { KeyRotationActor, KeyRotationResult } from './key-rotation.model';
import type { MetricsService } from '../common/metrics/metrics.service';
import {
  KEY_ENVELOPE_PROVIDER,
  KeyRotationService,
  WALLET_KEY_STORE,
  type KeyEnvelopeProvider,
  type WalletKeyRecord,
  type WalletKeyStore,
} from './key-rotation.service';

const OWNER: KeyRotationActor = {
  subjectId: 'owner-1',
  role: 'owner',
  correlationId: 'corr-1',
};

const ENVELOPE_V1 = 'opaque-envelope-v1';
const ENVELOPE_V2 = 'opaque-envelope-v2';

function walletRecord(
  overrides: Partial<WalletKeyRecord> = {},
): WalletKeyRecord {
  return {
    id: 'wallet-1',
    userId: 'owner-1',
    keyVersion: 1,
    encryptionVersion: 1,
    secretVersion: 3,
    network: 'testnet',
    encryptedSecret: ENVELOPE_V1,
    ...overrides,
  };
}

function provider(
  reEncrypt: KeyEnvelopeProvider['reEncrypt'] = jest
    .fn()
    .mockResolvedValue({ encryptedSecret: ENVELOPE_V2, encryptionVersion: 2 }),
): KeyEnvelopeProvider {
  return { reEncrypt };
}

function buildService(
  options: {
    wallet?: WalletKeyRecord | null;
    envelopes?: KeyEnvelopeProvider;
  } = {},
) {
  const stored = options.wallet === undefined ? walletRecord() : options.wallet;
  const store: WalletKeyStore = {
    wallet: {
      findUnique: jest.fn(() => Promise.resolve(stored)),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...stored, ...data }),
      ),
    },
  };
  const metrics = { incrementCounter: jest.fn() } as unknown as MetricsService;
  const service = new KeyRotationService(store, options.envelopes, metrics);
  return { service, store, metrics };
}

function rotationLogOf(
  service: KeyRotationService,
): Map<string, KeyRotationResult> {
  return (service as unknown as { rotationLog: Map<string, KeyRotationResult> })
    .rotationLog;
}

function findReplayOf(
  service: KeyRotationService,
  walletId: string,
  targetKeyVersion: number,
  idempotencyKey: string,
): Promise<KeyRotationResult | null> {
  return (
    service as unknown as {
      findReplay(
        walletId: string,
        targetKeyVersion: number,
        idempotencyKey: string,
      ): Promise<KeyRotationResult | null>;
    }
  ).findReplay(walletId, targetKeyVersion, idempotencyKey);
}

function setRotationEnabled(enabled: boolean): void {
  if (enabled) {
    process.env[KEY_ROTATION_ENABLED_ENV] = 'true';
  } else {
    delete process.env[KEY_ROTATION_ENABLED_ENV];
  }
}

function rotationResult(
  rotatedAt: Date,
  overrides: Partial<KeyRotationResult> = {},
): KeyRotationResult {
  return {
    walletId: 'wallet-1',
    previousKeyVersion: 1,
    keyVersion: 2,
    secretVersion: 4,
    rotatedAt,
    applied: true,
    ...overrides,
  };
}

const initialFlag = process.env[KEY_ROTATION_ENABLED_ENV];
beforeEach(() => setRotationEnabled(false));
afterAll(() => {
  if (initialFlag === undefined) {
    delete process.env[KEY_ROTATION_ENABLED_ENV];
  } else {
    process.env[KEY_ROTATION_ENABLED_ENV] = initialFlag;
  }
});

describe('KeyRotationService.reEncrypt delegation (KeyEnvelopeProvider contract)', () => {
  it('re-encrypts the same opaque envelope under the new derivation scheme and persists only the returned envelope', async () => {
    setRotationEnabled(true);
    const reEncrypt = jest.fn().mockResolvedValue({
      encryptedSecret: ENVELOPE_V2,
      encryptionVersion: 2,
    });
    const { service, store } = buildService({ envelopes: { reEncrypt } });

    const result = await service.rotateKeyVersion(
      'wallet-1',
      2,
      OWNER,
      'idem-encrypt',
    );

    // The service hands the envelope through opaquely; it never derives key
    // material itself and never sees plaintext.
    expect(reEncrypt).toHaveBeenCalledTimes(1);
    expect(reEncrypt).toHaveBeenCalledWith({
      encryptedSecret: ENVELOPE_V1,
      fromKeyVersion: 1,
      toKeyVersion: 2,
    });
    expect(store.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
      data: expect.objectContaining({
        keyVersion: 2,
        encryptionVersion: 2,
        secretVersion: 4,
        encryptedSecret: ENVELOPE_V2,
      }),
    });
    expect(result).toEqual({
      walletId: 'wallet-1',
      previousKeyVersion: 1,
      keyVersion: 2,
      secretVersion: 4,
      rotatedAt: expect.any(Date),
      applied: true,
    });
    expect(JSON.stringify(result)).not.toContain('opaque-envelope');
  });

  it('fails closed when the provider refuses an envelope it cannot decrypt', async () => {
    setRotationEnabled(true);
    const reEncrypt = jest
      .fn()
      .mockRejectedValue(new Error('ciphertext authentication failed'));
    const { service, store, metrics } = buildService({
      envelopes: { reEncrypt },
    });

    const rotation = service.rotateKeyVersion(
      'wallet-1',
      2,
      OWNER,
      'idem-decrypt-fail',
    );

    await expect(rotation).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(rotation).rejects.toMatchObject({
      response: expect.objectContaining({
        code: KeyRotationErrorCode.DECRYPT_FAILED,
        // The provider's crypto detail must not leak to the caller.
        message: expect.not.stringContaining(
          'ciphertext authentication failed',
        ),
      }),
    });
    expect(store.wallet.update).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'key_rotation_decrypt_failed',
    );
  });
});

describe('KeyRotationService.rotationLog (completed rotations Map)', () => {
  it('keys completed rotations by idempotency key', async () => {
    setRotationEnabled(true);
    const { service } = buildService({ envelopes: provider() });

    await service.rotateKeyVersion('wallet-1', 2, OWNER, 'idem-a');
    await service.rotateKeyVersion('wallet-1', 2, OWNER, 'idem-b');

    const log = rotationLogOf(service);
    expect([...log.keys()]).toEqual(['wallet-1:idem-a', 'wallet-1:idem-b']);
    expect(log.get('wallet-1:idem-a')).toMatchObject({
      walletId: 'wallet-1',
      keyVersion: 2,
      applied: true,
    });
  });

  it('treats an entry older than the replay window as absent and removes it', async () => {
    setRotationEnabled(true);
    const reEncrypt = jest.fn().mockResolvedValue({
      encryptedSecret: ENVELOPE_V2,
      encryptionVersion: 2,
    });
    const { service } = buildService({ envelopes: { reEncrypt } });
    const log = rotationLogOf(service);
    log.set(
      'wallet-1:idem-expired',
      rotationResult(new Date(Date.now() - ROTATION_REPLAY_WINDOW_MS - 1000)),
    );

    const replay = await findReplayOf(service, 'wallet-1', 2, 'idem-expired');

    expect(replay).toBeNull();
    expect(log.has('wallet-1:idem-expired')).toBe(false);
  });

  it('prunes expired entries on write without losing live replays', async () => {
    setRotationEnabled(true);
    const reEncrypt = jest.fn().mockResolvedValue({
      encryptedSecret: ENVELOPE_V2,
      encryptionVersion: 2,
    });
    const { service } = buildService({ envelopes: { reEncrypt } });
    const log = rotationLogOf(service);
    log.set(
      'wallet-1:idem-expired',
      rotationResult(new Date(Date.now() - ROTATION_REPLAY_WINDOW_MS - 1000)),
    );
    const live = rotationResult(new Date());
    log.set('wallet-1:idem-live', live);

    await service.rotateKeyVersion('wallet-1', 2, OWNER, 'idem-new');

    expect(log.has('wallet-1:idem-expired')).toBe(false);
    expect(log.get('wallet-1:idem-live')).toEqual(live);
    expect(log.has('wallet-1:idem-new')).toBe(true);
    expect(log.size).toBe(2);

    const replay = await service.rotateKeyVersion(
      'wallet-1',
      2,
      OWNER,
      'idem-live',
    );
    expect(replay).toEqual({ ...live, applied: false });
    expect(reEncrypt).toHaveBeenCalledTimes(1);
  });
});

describe('KeyRotationService optional envelope provider (@Optional())', () => {
  it('marks only the envelope provider parameter as optional at DI level', () => {
    const optional = Reflect.getMetadata(
      OPTIONAL_DEPS_METADATA,
      KeyRotationService,
    ) as number[];
    expect(optional).toContain(1);
    expect(optional).not.toContain(0);
    expect(optional).not.toContain(2);

    const injections = Reflect.getMetadata(
      SELF_DECLARED_DEPS_METADATA,
      KeyRotationService,
    ) as Array<{ index: number; param: string }>;
    expect(injections).toEqual(
      expect.arrayContaining([
        { index: 0, param: WALLET_KEY_STORE },
        { index: 1, param: KEY_ENVELOPE_PROVIDER },
      ]),
    );
    // The required `metrics` parameter still follows the optional one.
    const paramTypes = Reflect.getMetadata(
      PARAMTYPES_METADATA,
      KeyRotationService,
    ) as unknown[];
    expect(paramTypes).toHaveLength(3);
  });

  it('still serves reads and the kill-switch gate when the provider is unbound', async () => {
    const { service } = buildService({ envelopes: undefined });

    expect(service.isKeyRotationEnabled()).toBe(false);
    await expect(
      service.getKeyMetadata('wallet-1', OWNER),
    ).resolves.toMatchObject({ walletId: 'wallet-1', keyVersion: 1 });

    setRotationEnabled(true);
    expect(service.isKeyRotationEnabled()).toBe(true);
  });

  it('refuses to rotate when the custody provider is unbound', async () => {
    setRotationEnabled(true);
    const { service, store, metrics } = buildService({
      envelopes: undefined,
    });

    const rotation = service.rotateKeyVersion(
      'wallet-1',
      2,
      OWNER,
      'idem-unbound',
    );

    await expect(rotation).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(rotation).rejects.toMatchObject({
      response: expect.objectContaining({
        code: KeyRotationErrorCode.DEPENDENCY_UNAVAILABLE,
      }),
    });
    expect(store.wallet.update).not.toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'key_rotation_envelope_provider_unbound',
    );
  });
});

describe('KeyRotationService.getKeyMetadata', () => {
  it('returns versions and network only — no field can carry key material', async () => {
    const { service, store } = buildService();

    const metadata = await service.getKeyMetadata('wallet-1', OWNER);

    expect(metadata).toEqual({
      walletId: 'wallet-1',
      keyVersion: 1,
      encryptionVersion: 1,
      secretVersion: 3,
      network: 'testnet',
      supported: SUPPORTED_KEY_VERSIONS.includes(1),
      upToDate: CURRENT_KEY_VERSION === 1,
    });
    expect(Object.keys(metadata).sort()).toEqual([
      'encryptionVersion',
      'keyVersion',
      'network',
      'secretVersion',
      'supported',
      'upToDate',
      'walletId',
    ]);
    expect(JSON.stringify(metadata)).not.toContain('opaque-envelope');
    expect(store.wallet.findUnique).toHaveBeenCalledWith({
      where: { id: 'wallet-1' },
    });
  });

  const readers: Array<[string, KeyRotationActor]> = [
    [
      'delegate',
      { subjectId: 'delegate-1', role: 'delegate', correlationId: 'c' },
    ],
    [
      'guardian',
      { subjectId: 'guardian-1', role: 'guardian', correlationId: 'c' },
    ],
    [
      'api-key',
      { subjectId: 'api-key-1', role: 'api-key', correlationId: 'c' },
    ],
    ['jwt', { subjectId: 'jwt-1', role: 'jwt', correlationId: 'c' }],
  ];

  it.each(readers)(
    'allows a %s principal to read metadata',
    async (_label, actor) => {
      const { service } = buildService();

      await expect(
        service.getKeyMetadata('wallet-1', actor),
      ).resolves.toMatchObject({ walletId: 'wallet-1', keyVersion: 1 });
    },
  );

  it('refuses a caller claiming ownership of a wallet they do not own', async () => {
    const { service } = buildService();
    const intruder: KeyRotationActor = {
      subjectId: 'intruder-1',
      role: 'owner',
      correlationId: 'c',
    };

    await expect(
      service.getKeyMetadata('wallet-1', intruder),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a missing wallet', async () => {
    const { service } = buildService({ wallet: null });

    await expect(
      service.getKeyMetadata('wallet-1', OWNER),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: KeyRotationErrorCode.WALLET_NOT_FOUND,
      }),
    });
  });

  it('refuses an invalid wallet id', async () => {
    const { service } = buildService();

    await expect(
      service.getKeyMetadata('../etc/passwd', OWNER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
