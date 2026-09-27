import {
  ALLOWED_CONTRACT_FUNCTIONS,
  SorobanNetwork,
} from './soroban-invoke.model';
import {
  contractIdEnvKey,
  isValidContractIdStrKey,
  SOROBAN_CONTRACT_BOOT_ERROR_CODES,
  SorobanContractBootValidatorService,
} from './soroban-contract-boot-validator.service';

/**
 * Two structurally valid, distinct contract ids with correct CRC checksums
 * (deterministic 32-byte payloads encoded with `StrKey.encodeContract`).
 */
const TESTNET_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const MAINNET_ID = 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ';

/** A contract-shaped string with a broken checksum. */
const BAD_CHECKSUM_ID = `C${TESTNET_ID.slice(1, -1)}X`;

/** Runs the boot gate and returns the failure message (empty when it boots). */
const captureBootError = (
  validator: SorobanContractBootValidatorService,
): string => {
  try {
    validator.onModuleInit();
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

describe('SorobanContractBootValidatorService (#954)', () => {
  let validator: SorobanContractBootValidatorService;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    validator = new SorobanContractBootValidatorService();
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /** A fully valid configuration: every allowlisted contract, both networks. */
  const validEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { SOROBAN_INVOKE_ENABLED: 'true' };
    for (const contract of [
      ...new Set(ALLOWED_CONTRACT_FUNCTIONS.map((e) => e.contract)),
    ]) {
      env[contractIdEnvKey(contract, SorobanNetwork.TESTNET)] = TESTNET_ID;
      env[contractIdEnvKey(contract, SorobanNetwork.MAINNET)] = MAINNET_ID;
    }
    return { ...env, ...extra };
  };

  describe('isValidContractIdStrKey()', () => {
    it('accepts a real contract id', () => {
      expect(isValidContractIdStrKey(TESTNET_ID)).toBe(true);
    });

    it('rejects a non-string, empty, and wrong-length value', () => {
      expect(isValidContractIdStrKey(undefined)).toBe(false);
      expect(isValidContractIdStrKey(42)).toBe(false);
      expect(isValidContractIdStrKey('')).toBe(false);
      // Truncated paste.
      expect(isValidContractIdStrKey(TESTNET_ID.slice(0, 50))).toBe(false);
      // One character too long.
      expect(isValidContractIdStrKey(`${TESTNET_ID}A`)).toBe(false);
    });

    it('rejects a Stellar account address pasted into the contract field', () => {
      expect(
        isValidContractIdStrKey(
          'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        ),
      ).toBe(false);
    });

    it('rejects a secret seed', () => {
      expect(isValidContractIdStrKey(`S${'A'.repeat(68)}`)).toBe(false);
    });

    it('rejects a broken checksum', () => {
      expect(isValidContractIdStrKey(BAD_CHECKSUM_ID)).toBe(false);
    });

    it('rejects a character outside the StrKey base32 alphabet', () => {
      // "1" and "0" are not in the base32 alphabet.
      expect(isValidContractIdStrKey(`C${TESTNET_ID.slice(1, -1)}1`)).toBe(
        false,
      );
    });
  });
  describe('validate()', () => {
    it('reports valid when every allowlisted contract has distinct valid ids', () => {
      const snapshot = validator.validate(validEnv());

      expect(snapshot.valid).toBe(true);
      expect(snapshot.errors).toEqual([]);
      expect(snapshot.invokeEnabled).toBe(true);
      expect(snapshot.configured).toEqual(['spend_limit', 'wallet_registry']);
    });

    it('reports a missing id as CONTRACT_ID_MISSING with the env key to set', () => {
      const env = validEnv();
      delete env[contractIdEnvKey('wallet_registry', SorobanNetwork.MAINNET)];

      const snapshot = validator.validate(env);

      expect(snapshot.valid).toBe(false);
      expect(snapshot.errors).toContainEqual({
        code: SOROBAN_CONTRACT_BOOT_ERROR_CODES.CONTRACT_ID_MISSING,
        contract: 'wallet_registry',
        network: SorobanNetwork.MAINNET,
        envKey: 'SOROBAN_CONTRACT_WALLET_REGISTRY_MAINNET_ID',
      });
    });

    it('treats an empty or whitespace-only value as missing', () => {
      const snapshot = validator.validate(
        validEnv({
          [contractIdEnvKey('spend_limit', SorobanNetwork.TESTNET)]: '   ',
        }),
      );

      expect(snapshot.errors).toContainEqual(
        expect.objectContaining({
          code: SOROBAN_CONTRACT_BOOT_ERROR_CODES.CONTRACT_ID_MISSING,
          contract: 'spend_limit',
        }),
      );
    });

    it('reports a malformed id as CONTRACT_ID_INVALID', () => {
      const snapshot = validator.validate(
        validEnv({
          [contractIdEnvKey('spend_limit', SorobanNetwork.TESTNET)]:
            'not-an-id',
        }),
      );

      expect(snapshot.errors).toContainEqual(
        expect.objectContaining({
          code: SOROBAN_CONTRACT_BOOT_ERROR_CODES.CONTRACT_ID_INVALID,
          contract: 'spend_limit',
          network: SorobanNetwork.TESTNET,
        }),
      );
    });

    it('reports the same id on both networks as a copy-paste collision', () => {
      const snapshot = validator.validate(
        validEnv({
          [contractIdEnvKey('wallet_registry', SorobanNetwork.MAINNET)]:
            TESTNET_ID,
        }),
      );

      expect(snapshot.errors).toContainEqual(
        expect.objectContaining({
          code: SOROBAN_CONTRACT_BOOT_ERROR_CODES.CONTRACT_ID_NETWORK_COLLISION,
          contract: 'wallet_registry',
        }),
      );
    });

    it('does not demand a mainnet id for a testnet-only contract', () => {
      // spend_limit.set_limit has mainnetEnabled: false, so a testnet-only
      // deployment is legitimate and must still boot.
      const snapshot = validator.validate({
        SOROBAN_INVOKE_ENABLED: 'true',
        [contractIdEnvKey('wallet_registry', SorobanNetwork.TESTNET)]:
          TESTNET_ID,
        [contractIdEnvKey('wallet_registry', SorobanNetwork.MAINNET)]:
          MAINNET_ID,
        [contractIdEnvKey('spend_limit', SorobanNetwork.TESTNET)]: TESTNET_ID,
      });

      expect(snapshot.errors).toEqual([]);
      expect(snapshot.valid).toBe(true);
    });

    it('does not block boot when the invoke surface is disabled', () => {
      const snapshot = validator.validate({ SOROBAN_INVOKE_ENABLED: 'false' });

      expect(snapshot.invokeEnabled).toBe(false);
      // Findings are still reported so an operator can see them...
      expect(snapshot.errors.length).toBeGreaterThan(0);
      // ...but they do not block a deployment that never invokes a contract.
      expect(snapshot.valid).toBe(true);
    });

    it('treats any value other than true/1 as disabled', () => {
      for (const raw of ['yes', 'TRUE', '1 ', undefined, '']) {
        expect(validator.isInvokeEnabled({ SOROBAN_INVOKE_ENABLED: raw })).toBe(
          false,
        );
      }
      expect(
        validator.isInvokeEnabled({ SOROBAN_INVOKE_ENABLED: 'true' }),
      ).toBe(true);
      expect(validator.isInvokeEnabled({ SOROBAN_INVOKE_ENABLED: '1' })).toBe(
        true,
      );
    });

    it('never returns a configured id in the snapshot or the errors', () => {
      const snapshot = validator.validate(
        validEnv({
          [contractIdEnvKey('spend_limit', SorobanNetwork.TESTNET)]: 'nope',
        }),
      );

      expect(JSON.stringify(snapshot)).not.toContain(MAINNET_ID);
      expect(JSON.stringify(snapshot)).not.toContain(TESTNET_ID);
    });
  });
  describe('onModuleInit()', () => {
    it('starts cleanly when the surface is disabled and nothing is configured', () => {
      process.env = { SOROBAN_INVOKE_ENABLED: 'false' };

      expect(() => validator.onModuleInit()).not.toThrow();
    });

    it('starts cleanly when the surface is enabled and every id is valid', () => {
      process.env = validEnv();

      expect(() => validator.onModuleInit()).not.toThrow();
    });

    it('refuses to start when an enabled surface has a missing id', () => {
      const env = validEnv();
      delete env[contractIdEnvKey('wallet_registry', SorobanNetwork.MAINNET)];
      process.env = env;

      expect(() => validator.onModuleInit()).toThrow(
        /SOROBAN_CONTRACT_ID_MISSING/,
      );
    });

    it('names the contract, network, and env var in the failure message', () => {
      process.env = { SOROBAN_INVOKE_ENABLED: 'true' };

      const message = captureBootError(validator);

      expect(message).toContain('wallet_registry');
      expect(message).toContain('MAINNET');
      expect(message).toContain('SOROBAN_CONTRACT_WALLET_REGISTRY_MAINNET_ID');
      // The message must point at the escape hatch, not just the failure.
      expect(message).toContain('SOROBAN_INVOKE_ENABLED=false');
    });

    it('does not leak the configured id value into the failure message', () => {
      process.env = validEnv({
        [contractIdEnvKey('spend_limit', SorobanNetwork.TESTNET)]:
          'garbage-id-value',
      });

      const message = captureBootError(validator);

      expect(message).toContain('SOROBAN_CONTRACT_ID_INVALID');
      expect(message).not.toContain('garbage-id-value');
    });
  });
});
