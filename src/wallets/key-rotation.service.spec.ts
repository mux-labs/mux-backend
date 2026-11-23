import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  OPTIONAL_DEPS_METADATA,
  PARAMTYPES_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { KeyRotationService } from './key-rotation.service';
import type { WalletKeyRecord } from './key-rotation.service';
import {
  KEY_ENVELOPE_PROVIDER,
  WALLET_KEY_STORE,
  type KeyEnvelopeProvider,
} from './key-rotation.service';
import {
  CURRENT_KEY_VERSION,
  KeyRotationErrorCode,
  KEY_ROTATION_ENABLED_ENV,
  ROTATION_REPLAY_WINDOW_MS,
  SUPPORTED_KEY_VERSIONS,
} from './key-rotation.model';
import type { KeyRotationActor, KeyRotationResult } from './key-rotation.model';
import { MetricsService } from '../common/metrics/metrics.service';

const WALLET_ID = 'wallet-1';
const OWNER = 'user-owner';
const ENVELOPE = 'ENC:v1:Zm9vYmFy';

const owner: KeyRotationActor = {
  subjectId: OWNER,
  role: 'owner',
  correlationId: 'corr-1',
};

function walletRow(overrides: Partial<WalletKeyRecord> = {}): WalletKeyRecord {
  return {
    id: WALLET_ID,
    userId: OWNER,
    keyVersion: 1,
    encryptionVersion: 1,
    secretVersion: 1,
    network: 'TESTNET',
    encryptedSecret: ENVELOPE,
    ...overrides,
  };
}

describe('KeyRotationService', () => {
  let service: KeyRotationService;
  let store: { wallet: { findUnique: jest.Mock; update: jest.Mock } };
  let envelopes: { reEncrypt: jest.Mock };
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    process.env[KEY_ROTATION_ENABLED_ENV] = 'true';

    store = {
      wallet: {
        findUnique: jest.fn().mockResolvedValue(walletRow()),
        update: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve(
              walletRow({
                keyVersion: args.data.keyVersion as number,
                encryptionVersion: args.data.encryptionVersion as number,
                secretVersion: args.data.secretVersion as number,
                encryptedSecret: args.data.encryptedSecret as string,
              }),
            ),
          ),
      },
    };
    envelopes = {
      reEncrypt: jest.fn().mockResolvedValue({
        encryptedSecret: 'ENC:v2:YmF6cXV4',
        encryptionVersion: 2,
      }),
    };
    metrics = { incrementCounter: jest.fn() };

    service = new KeyRotationService(
      store,
      envelopes,
      metrics as unknown as MetricsService,
    );
  });

  afterEach(() => {
    delete process.env[KEY_ROTATION_ENABLED_ENV];
    jest.restoreAllMocks();
  });

  describe('happy path', () => {
    it('rotates a wallet forward and bumps the secret counter', async () => {
      const result = await service.rotateKeyVersion(WALLET_ID, 2, owner);

      expect(result.previousKeyVersion).toBe(1);
      expect(result.keyVersion).toBe(2);
      expect(result.secretVersion).toBe(2);
      expect(result.applied).toBe(true);
      expect(store.wallet.update).toHaveBeenCalledTimes(1);
    });

    it('passes the stored envelope and versions to the crypto provider', async () => {
      await service.rotateKeyVersion(WALLET_ID, 2, owner);

      expect(envelopes.reEncrypt).toHaveBeenCalledWith({
        encryptedSecret: ENVELOPE,
        fromKeyVersion: 1,
        toKeyVersion: 2,
      });
    });

    it('never returns key material in the result', async () => {
      const result = await service.rotateKeyVersion(WALLET_ID, 2, owner);
      const serialized = JSON.stringify(result);

      expect(serialized).not.toContain(ENVELOPE);
      expect(serialized).not.toContain('Zm9vYmFy');
    });
  });

  describe('fail-closed decrypt', () => {
    it('refuses when the envelope cannot be decrypted and writes nothing', async () => {
      envelopes.reEncrypt.mockRejectedValue(new Error('bad ciphertext'));

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, owner),
      ).rejects.toMatchObject({
        response: { code: KeyRotationErrorCode.DECRYPT_FAILED },
      });

      // Critical: a failed decrypt must not leave the wallet half-rotated.
      expect(store.wallet.update).not.toHaveBeenCalled();
    });

    it('refuses a wallet whose stored version is outside the supported set', async () => {
      store.wallet.findUnique.mockResolvedValue(walletRow({ keyVersion: 99 }));

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, owner),
      ).rejects.toMatchObject({
        response: { code: KeyRotationErrorCode.VERSION_UNSUPPORTED },
      });

      // Never assumes an unknown version is "the latest".
      expect(envelopes.reEncrypt).not.toHaveBeenCalled();
      expect(store.wallet.update).not.toHaveBeenCalled();
    });

    it('rejects an unsupported target version', async () => {
      await expect(
        service.rotateKeyVersion(WALLET_ID, 42, owner),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(envelopes.reEncrypt).not.toHaveBeenCalled();
    });
  });

  describe('monotonicity', () => {
    it('rejects a no-op rotation to the current version', async () => {
      await expect(
        service.rotateKeyVersion(WALLET_ID, 1, owner),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(envelopes.reEncrypt).not.toHaveBeenCalled();
    });

    it('rejects a downgrade', async () => {
      store.wallet.findUnique.mockResolvedValue(walletRow({ keyVersion: 2 }));

      await expect(
        service.rotateKeyVersion(WALLET_ID, 1, owner),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(store.wallet.update).not.toHaveBeenCalled();
    });
  });

  describe('authorization (deny-by-default)', () => {
    it('refuses a delegate', async () => {
      // A delegate may read metadata but must never rotate key material.
      const delegate: KeyRotationActor = {
        subjectId: 'user-delegate',
        role: 'delegate',
        correlationId: 'corr-2',
      };

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, delegate),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(envelopes.reEncrypt).not.toHaveBeenCalled();
    });

    it('refuses an owner role claimed for a wallet the caller does not own', async () => {
      // The role is verified against the stored userId, not trusted from input.
      const impostor: KeyRotationActor = {
        subjectId: 'user-attacker',
        role: 'owner',
        correlationId: 'corr-3',
      };

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, impostor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(store.wallet.update).not.toHaveBeenCalled();
    });

    it('allows a guardian', async () => {
      const guardian: KeyRotationActor = {
        subjectId: 'user-guardian',
        role: 'guardian',
        correlationId: 'corr-4',
      };

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, guardian),
      ).resolves.toMatchObject({
        keyVersion: 2,
      });
    });

    it('checks authz before touching the crypto provider', async () => {
      const delegate: KeyRotationActor = {
        subjectId: 'user-delegate',
        role: 'delegate',
        correlationId: 'corr-5',
      };

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, delegate),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Authz runs first so a denied caller cannot probe the envelope at all.
      expect(envelopes.reEncrypt).not.toHaveBeenCalled();
    });

    it('refuses metadata reads for a non-owner claiming the owner role', async () => {
      const impostor: KeyRotationActor = {
        subjectId: 'user-attacker',
        role: 'owner',
        correlationId: 'corr-6',
      };

      await expect(
        service.getKeyMetadata(WALLET_ID, impostor),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('allows a delegate to read metadata', async () => {
      const delegate: KeyRotationActor = {
        subjectId: 'user-delegate',
        role: 'delegate',
        correlationId: 'corr-7',
      };

      const metadata = await service.getKeyMetadata(WALLET_ID, delegate);
      expect(metadata.keyVersion).toBe(1);
      expect(metadata.supported).toBe(true);
    });

    it('exposes no key material through metadata', async () => {
      const metadata = await service.getKeyMetadata(WALLET_ID, owner);
      expect(JSON.stringify(metadata)).not.toContain(ENVELOPE);
    });
  });

  describe('idempotency / replay', () => {
    it('returns the original result and does not re-encrypt on replay', async () => {
      const first = await service.rotateKeyVersion(
        WALLET_ID,
        2,
        owner,
        'idem-1',
      );
      const second = await service.rotateKeyVersion(
        WALLET_ID,
        2,
        owner,
        'idem-1',
      );

      expect(second.keyVersion).toBe(first.keyVersion);
      expect(second.applied).toBe(false);
      // The decisive assertion: a replay must not re-encrypt or write again.
      expect(envelopes.reEncrypt).toHaveBeenCalledTimes(1);
      expect(store.wallet.update).toHaveBeenCalledTimes(1);
    });

    it('flags an idempotency key reused for a different target version', async () => {
      // Record a rotation of this wallet to version 2 under `idem-2`.
      await service.rotateKeyVersion(WALLET_ID, 2, owner, 'idem-2');

      // Reuse the same key for a *different* target. The service must refuse
      // rather than silently re-run, otherwise the caller would believe a
      // rotation to the new target happened when the recorded one went to 2.
      // The stored row is rewound so the idempotency check — which runs before
      // the monotonicity check — is what actually rejects the request.
      store.wallet.findUnique.mockResolvedValue(walletRow({ keyVersion: 1 }));

      await expect(
        service.rotateKeyVersion(WALLET_ID, 1, owner, 'idem-2'),
      ).rejects.toMatchObject({
        response: { code: KeyRotationErrorCode.IDEMPOTENCY_CONFLICT },
      });

      // The conflicting request must not have written anything.
      expect(store.wallet.update).toHaveBeenCalledTimes(1);
    });

    it('does not treat one wallet’s idempotency key as another’s', async () => {
      await service.rotateKeyVersion(WALLET_ID, 2, owner, 'shared-key');

      const other: KeyRotationActor = {
        subjectId: OWNER,
        role: 'owner',
        correlationId: 'corr-8',
      };
      store.wallet.findUnique.mockResolvedValue(walletRow({ id: 'wallet-2' }));

      // Keys are namespaced by wallet, so wallet-2 gets a genuinely fresh rotation.
      await expect(
        service.rotateKeyVersion('wallet-2', 2, other, 'shared-key'),
      ).resolves.toMatchObject({ applied: true });
    });
  });

  describe('kill-switch', () => {
    it('refuses rotation when KEY_ROTATION_ENABLED is unset', async () => {
      delete process.env[KEY_ROTATION_ENABLED_ENV];

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, owner),
      ).rejects.toMatchObject({
        response: { code: KeyRotationErrorCode.FEATURE_FLAG_DISABLED },
      });
      expect(envelopes.reEncrypt).not.toHaveBeenCalled();
      expect(store.wallet.update).not.toHaveBeenCalled();
    });

    it('treats a non-truthy flag value as disabled', () => {
      process.env[KEY_ROTATION_ENABLED_ENV] = 'enabled';
      expect(service.isKeyRotationEnabled()).toBe(false);
    });

    it('still serves metadata reads while rotation is off', async () => {
      delete process.env[KEY_ROTATION_ENABLED_ENV];

      await expect(
        service.getKeyMetadata(WALLET_ID, owner),
      ).resolves.toMatchObject({
        keyVersion: 1,
      });
    });
  });

  describe('dependency outage (fail-closed)', () => {
    it('surfaces a read outage as a stable 503', async () => {
      store.wallet.findUnique.mockRejectedValue(
        new Error('connect ECONNREFUSED 10.0.0.5:5432'),
      );

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, owner),
      ).rejects.toMatchObject({
        response: { code: KeyRotationErrorCode.DEPENDENCY_UNAVAILABLE },
      });
    });

    it('surfaces a write outage as a stable 503', async () => {
      store.wallet.update.mockRejectedValue(new Error('deadlock detected'));

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, owner),
      ).rejects.toMatchObject({
        response: { code: KeyRotationErrorCode.DEPENDENCY_UNAVAILABLE },
      });
    });

    it('404s for an unknown wallet', async () => {
      store.wallet.findUnique.mockResolvedValue(null);

      await expect(
        service.rotateKeyVersion('missing', 2, owner),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(envelopes.reEncrypt).not.toHaveBeenCalled();
    });
  });

  describe('adversarial input', () => {
    it('rejects a wallet id usable for log injection', async () => {
      await expect(
        service.rotateKeyVersion('wallet\nlevel=ERROR', 2, owner),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.wallet.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a non-integer target version', async () => {
      await expect(
        service.rotateKeyVersion(WALLET_ID, 1.5, owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a negative target version', async () => {
      await expect(
        service.rotateKeyVersion(WALLET_ID, -1, owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('observability', () => {
    it('never logs the encrypted envelope', async () => {
      const logSpy = jest
        .spyOn(
          (
            service as unknown as {
              logger: { log: (m: string) => void; error: (m: string) => void };
            }
          ).logger,
          'log',
        )
        .mockImplementation(() => undefined);
      const errSpy = jest
        .spyOn(
          (
            service as unknown as {
              logger: { log: (m: string) => void; error: (m: string) => void };
            }
          ).logger,
          'error',
        )
        .mockImplementation(() => undefined);

      await service.rotateKeyVersion(WALLET_ID, 2, owner);
      envelopes.reEncrypt.mockRejectedValue(new Error('boom'));
      store.wallet.findUnique.mockResolvedValue(walletRow());
      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, owner),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      const logged = [...logSpy.mock.calls, ...errSpy.mock.calls]
        .flat()
        .join(' ');
      expect(logged).not.toContain(ENVELOPE);
      expect(logged).not.toContain('Zm9vYmFy');
    });

    it('emits a metric when the kill-switch blocks a rotation', async () => {
      delete process.env[KEY_ROTATION_ENABLED_ENV];

      await expect(
        service.rotateKeyVersion(WALLET_ID, 2, owner),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'key_rotation_blocked_by_flag',
      );
    });
  });
});

/**
 * Focused regressions for the four contracts documented on KeyRotationService:
 * reEncrypt, the replay Map, the optional envelope provider, and metadata reads.
 */
describe('KeyRotationService documented contracts (regressions)', () => {
  const originalFlag = process.env[KEY_ROTATION_ENABLED_ENV];

  const newEnvelope = 'ENC:v2:YmF6cXV4';

  function build(
    overrides: {
      wallet?: WalletKeyRecord | null;
      envelopes?: KeyEnvelopeProvider | undefined;
    } = {},
  ) {
    const row = overrides.wallet === undefined ? walletRow() : overrides.wallet;
    const store = {
      wallet: {
        findUnique: jest.fn(() => Promise.resolve(row)),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(
            walletRow({
              keyVersion: args.data.keyVersion as number,
              encryptionVersion: args.data.encryptionVersion as number,
              secretVersion: args.data.secretVersion as number,
              encryptedSecret: args.data.encryptedSecret as string,
            }),
          ),
        ),
      },
    };
    const metrics = { incrementCounter: jest.fn() };
    const service = new KeyRotationService(
      store,
      overrides.envelopes,
      metrics as unknown as MetricsService,
    );
    return { service, store, metrics };
  }

  function boundProvider(): KeyEnvelopeProvider {
    return {
      reEncrypt: jest.fn().mockResolvedValue({
        encryptedSecret: newEnvelope,
        encryptionVersion: 2,
      }),
    };
  }

  function rotationLogOf(
    service: KeyRotationService,
  ): Map<string, KeyRotationResult> {
    return (
      service as unknown as { rotationLog: Map<string, KeyRotationResult> }
    ).rotationLog;
  }

  function findReplayOf(
    service: KeyRotationService,
    walletId: string,
    targetKeyVersion: number,
    idempotencyKey: string,
  ): KeyRotationResult | null {
    return (
      service as unknown as {
        findReplay(
          walletId: string,
          targetKeyVersion: number,
          idempotencyKey: string,
        ): KeyRotationResult | null;
      }
    ).findReplay(walletId, targetKeyVersion, idempotencyKey);
  }

  function recorded(rotatedAt: Date): KeyRotationResult {
    return {
      walletId: WALLET_ID,
      previousKeyVersion: 1,
      keyVersion: 2,
      secretVersion: 2,
      rotatedAt,
      applied: true,
    };
  }

  beforeEach(() => {
    process.env[KEY_ROTATION_ENABLED_ENV] = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env[KEY_ROTATION_ENABLED_ENV];
    } else {
      process.env[KEY_ROTATION_ENABLED_ENV] = originalFlag;
    }
  });

  describe('reEncrypt (custody provider port)', () => {
    it('re-encrypts the same opaque envelope under the new derivation scheme', async () => {
      const envelopes = boundProvider();
      const { service, store } = build({ envelopes });

      const result = await service.rotateKeyVersion(
        WALLET_ID,
        2,
        owner,
        'idem-encrypt',
      );

      expect(envelopes.reEncrypt).toHaveBeenCalledTimes(1);
      expect(envelopes.reEncrypt).toHaveBeenCalledWith({
        encryptedSecret: ENVELOPE,
        fromKeyVersion: 1,
        toKeyVersion: 2,
      });
      expect(store.wallet.update).toHaveBeenCalledWith({
        where: { id: WALLET_ID },
        data: expect.objectContaining({
          keyVersion: 2,
          encryptionVersion: 2,
          secretVersion: 2,
          encryptedSecret: newEnvelope,
        }),
      });
      expect(JSON.stringify(result)).not.toContain('ENC:');
    });

    it('fails closed when the provider refuses an envelope it cannot decrypt', async () => {
      const reEncrypt = jest
        .fn()
        .mockRejectedValue(new Error('ciphertext authentication failed'));
      const { service, store, metrics } = build({ envelopes: { reEncrypt } });

      const rotation = service.rotateKeyVersion(
        WALLET_ID,
        2,
        owner,
        'idem-decrypt',
      );

      await expect(rotation).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(rotation).rejects.toMatchObject({
        response: expect.objectContaining({
          code: KeyRotationErrorCode.DECRYPT_FAILED,
          // Provider crypto detail must not reach the caller.
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

  describe('rotationLog (completed rotations Map)', () => {
    it('keys completed rotations by idempotency key', async () => {
      const { service } = build({ envelopes: boundProvider() });

      await service.rotateKeyVersion(WALLET_ID, 2, owner, 'idem-a');
      await service.rotateKeyVersion(WALLET_ID, 2, owner, 'idem-b');

      const log = rotationLogOf(service);
      expect([...log.keys()]).toEqual([
        `${WALLET_ID}:idem-a`,
        `${WALLET_ID}:idem-b`,
      ]);
      expect(log.get(`${WALLET_ID}:idem-a`)).toMatchObject({
        walletId: WALLET_ID,
        keyVersion: 2,
        applied: true,
      });
    });

    it('treats an entry older than the replay window as absent and removes it', async () => {
      const { service } = build({ envelopes: boundProvider() });
      const log = rotationLogOf(service);
      log.set(
        `${WALLET_ID}:idem-expired`,
        recorded(new Date(Date.now() - ROTATION_REPLAY_WINDOW_MS - 1000)),
      );

      expect(findReplayOf(service, WALLET_ID, 2, 'idem-expired')).toBeNull();
      expect(log.has(`${WALLET_ID}:idem-expired`)).toBe(false);
    });

    it('prunes expired entries on write without losing live replays', async () => {
      const envelopes = boundProvider();
      const { service } = build({ envelopes });
      const log = rotationLogOf(service);
      log.set(
        `${WALLET_ID}:idem-expired`,
        recorded(new Date(Date.now() - ROTATION_REPLAY_WINDOW_MS - 1000)),
      );
      const live = recorded(new Date());
      log.set(`${WALLET_ID}:idem-live`, live);

      await service.rotateKeyVersion(WALLET_ID, 2, owner, 'idem-new');

      expect(log.has(`${WALLET_ID}:idem-expired`)).toBe(false);
      expect(log.get(`${WALLET_ID}:idem-live`)).toEqual(live);
      expect(log.has(`${WALLET_ID}:idem-new`)).toBe(true);
      expect(log.size).toBe(2);

      const replay = await service.rotateKeyVersion(
        WALLET_ID,
        2,
        owner,
        'idem-live',
      );
      expect(replay).toEqual({ ...live, applied: false });
      expect(envelopes.reEncrypt).toHaveBeenCalledTimes(1);
    });
  });

  describe('optional envelope provider (@Optional())', () => {
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
      const { service } = build({ envelopes: undefined });

      expect(service.isKeyRotationEnabled()).toBe(true);
      await expect(
        service.getKeyMetadata(WALLET_ID, owner),
      ).resolves.toMatchObject({ walletId: WALLET_ID, keyVersion: 1 });

      delete process.env[KEY_ROTATION_ENABLED_ENV];
      expect(service.isKeyRotationEnabled()).toBe(false);
    });

    it('refuses to rotate when the custody provider is unbound', async () => {
      const { service, store, metrics } = build({ envelopes: undefined });

      const rotation = service.rotateKeyVersion(
        WALLET_ID,
        2,
        owner,
        'idem-unbound',
      );

      await expect(rotation).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
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

  describe('getKeyMetadata (versions only)', () => {
    it('returns versions and network only — no field can carry key material', async () => {
      const { service, store } = build();
      const storedVersion = walletRow().keyVersion;

      const metadata = await service.getKeyMetadata(WALLET_ID, owner);

      expect(metadata).toEqual({
        walletId: WALLET_ID,
        keyVersion: storedVersion,
        encryptionVersion: 1,
        secretVersion: 1,
        network: 'TESTNET',
        supported: SUPPORTED_KEY_VERSIONS.includes(storedVersion),
        upToDate: storedVersion === CURRENT_KEY_VERSION,
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
      expect(JSON.stringify(metadata)).not.toContain('ENC:');
      expect(store.wallet.findUnique).toHaveBeenCalledWith({
        where: { id: WALLET_ID },
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
        const { service } = build();

        await expect(
          service.getKeyMetadata(WALLET_ID, actor),
        ).resolves.toMatchObject({ walletId: WALLET_ID, keyVersion: 1 });
      },
    );

    it('refuses a caller claiming ownership of a wallet they do not own', async () => {
      const { service } = build();
      const intruder: KeyRotationActor = {
        subjectId: 'intruder-1',
        role: 'owner',
        correlationId: 'c',
      };

      await expect(
        service.getKeyMetadata(WALLET_ID, intruder),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
