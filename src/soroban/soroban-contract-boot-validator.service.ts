import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ALLOWED_CONTRACT_FUNCTIONS,
  SOROBAN_INVOKE_ENABLED_ENV,
  SorobanNetwork,
} from './soroban-invoke.model';

/**
 * Boot-time Soroban contract-id validator (issue #954).
 *
 * Design notes:
 * - `SorobanInvokeService` resolves contract ids through `ContractRegistryPort`,
 *   which a deployment binds to whatever store it uses. Nothing validated the
 *   *shape* of what came back: a truncated id, an address pasted into the wrong
 *   field, or a testnet id configured for mainnet would only surface as a
 *   confusing RPC failure on the first live invoke — after the surface is
 *   already enabled and taking traffic.
 * - This validator closes that window at boot. It runs during `OnModuleInit`, so
 *   a misconfigured deployment refuses to start instead of discovering the
 *   problem on the money path.
 *
 * Invariants:
 *  1. **Fail-closed.** When `SOROBAN_INVOKE_ENABLED=true`, every allowlisted
 *     contract must have a syntactically valid id configured for the network it
 *     is enabled on. Anything missing, malformed, or cross-network refuses boot.
 *  2. **Mainnet ids must be mainnet ids.** A contract id equal to the id
 *     configured for the other network is treated as a copy-paste misconfig and
 *     blocks startup, because driving mainnet value at a testnet deployment is
 *     exactly the failure this gate exists to prevent.
 *  3. **Deny-by-default.** The validator only blocks when the invoke surface is
 *     explicitly enabled. With the flag off (or unset) it reports and returns,
 *     so testnet/local flows are never disrupted.
 *  4. **Strict format.** A contract id must be a 69-character StrKey with a `C`
 *     version byte, correct base32 alphabet, and a valid CRC-16 checksum —
 *     verified by decoding it, not by regex alone.
 *  5. **No secret leakage.** Logs carry contract *names* from the allowlist and
 *     stable error codes. The configured id itself is never logged, only whether
 *     it is valid and which network it was validated for.
 *
 * Cross-links: `soroban-contract-boot-validator.spec.ts`,
 * `test/soroban-contract-boot.e2e-spec.ts`, `docs/SOROBAN-CONTRACT-ID-BOOT.md`.
 */

/** Stable error codes. Callers and dashboards match on these, never prose. */
export const SOROBAN_CONTRACT_BOOT_ERROR_CODES = {
  /** Invoke is enabled but no id is configured for an allowlisted contract. */
  CONTRACT_ID_MISSING: 'SOROBAN_CONTRACT_ID_MISSING',
  /** The configured value is not a valid Soroban contract id. */
  CONTRACT_ID_INVALID: 'SOROBAN_CONTRACT_ID_INVALID',
  /** The same id is configured for both networks (copy-paste misconfig). */
  CONTRACT_ID_NETWORK_COLLISION: 'SOROBAN_CONTRACT_ID_NETWORK_COLLISION',
} as const;

export type SorobanContractBootErrorCode =
  (typeof SOROBAN_CONTRACT_BOOT_ERROR_CODES)[keyof typeof SOROBAN_CONTRACT_BOOT_ERROR_CODES];

/** A single validation finding. Carries no id material. */
export interface SorobanContractBootError {
  code: SorobanContractBootErrorCode;
  /** Allowlist contract name (never a client-supplied value). */
  contract: string;
  network: SorobanNetwork;
  /** The env var that should hold the id. */
  envKey: string;
}

/**
 * Ops-safe, secret-free snapshot of the boot validation. Booleans and stable
 * enum strings only — a contract id is public chain data, but it is still
 * deployment configuration and is kept out of logs.
 */
export interface SorobanContractBootSnapshot {
  valid: boolean;
  nodeEnv: string;
  invokeEnabled: boolean;
  /** Allowlist contract names that resolved a valid id, sorted. */
  configured: string[];
  errors: SorobanContractBootError[];
}

/** Environment variable holding a contract id, per contract and network. */
export const contractIdEnvKey = (
  contract: string,
  network: SorobanNetwork,
): string => `SOROBAN_CONTRACT_${contract.toUpperCase()}_${network}_ID`;

/**
 * Length of a base32-encoded StrKey for a 32-byte payload with a 2-byte CRC
 * checksum: 34 bytes = 272 bits = 56 base32 characters (5 bits each).
 */
const CONTRACT_ID_LENGTH = 56;

/** Stellar base32 alphabet used by StrKey (case-sensitive, as emitted by the SDK). */
const STRKEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * StrKey version byte for a contract id (`versionBytes.contract` in the SDK,
 * i.e. `2 << 3`). It is included in the CRC input, so a G-address cannot pass.
 */
const CONTRACT_VERSION_BYTE = 2 << 3;

/**
 * Structural check for a Soroban contract id.
 *
 * Deliberately does not verify the checksum — that needs base32 decoding plus
 * CRC-16, which {@link isValidContractIdStrKey} does. This cheap check exists so
 * an obviously wrong value (an address, a truncated paste, a seed) is reported
 * as `CONTRACT_ID_INVALID` with a clear reason before any heavier work.
 */
const isContractIdShaped = (value: string): boolean =>
  value.length === CONTRACT_ID_LENGTH &&
  value.startsWith('C') &&
  [...value].every((char) => STRKEY_ALPHABET.includes(char));

/**
 * Full validation of a contract id: shape **and** CRC-16 checksum.
 *
 * A shape check alone would accept a value that decodes to garbage, so the
 * StrKey payload and its CRC-16/XMODEM checksum are decoded and verified here.
 *
 * Implemented locally rather than via `@stellar/stellar-sdk` for two reasons: the
 * boot gate must not fail because of a module-resolution problem in an
 * ESM/CJS interop path, and a validator whose failure mode is "returns true when
 * the import fails" is worse than no validator at all.
 *
 * StrKey layout: 1 version byte (`C` for contract) + 32 payload bytes + 2 CRC
 * bytes, base32-encoded into 56 characters.
 */
export function isValidContractIdStrKey(value: unknown): boolean {
  if (typeof value !== 'string' || !isContractIdShaped(value)) {
    return false;
  }

  const decoded = decodeStrKeyBody(value);
  if (!decoded) {
    return false;
  }

  const { payload, versionByte, checksum } = decoded;
  if (versionByte !== CONTRACT_VERSION_BYTE) {
    // A well-formed StrKey of a different kind (an account address, a muxed
    // account) must not be accepted as a contract.
    return false;
  }
  // The CRC is computed over the version byte followed by the payload, matching
  // the SDK's `encodeCheck`.
  return (
    crc16Xmodem(Buffer.concat([Buffer.of(versionByte), payload])) === checksum
  );
}

/** Reverse lookup for the StrKey base32 alphabet. */
const STRKEY_VALUES: Record<string, number> = Object.fromEntries(
  [...STRKEY_ALPHABET].map((char, index) => [char, index]),
);

/**
 * Decodes the 56 base32 characters into the 35-byte StrKey body and returns the
 * payload, the version byte, and the CRC. Returns `null` when malformed.
 *
 * Note there is no separate version *prefix* in the encoded form: the 1-byte
 * version (0xcc for a contract) is the first of the 35 encoded bytes, which is
 * why 35 bytes is exactly 56 base32 characters with no padding at all.
 */
function decodeStrKeyBody(
  value: string,
): { payload: Buffer; versionByte: number; checksum: number } | null {
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];

  for (const char of value) {
    const digit = STRKEY_VALUES[char];
    if (digit === undefined) {
      return null;
    }
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }

  // 56 characters x 5 bits = 280 bits = exactly 35 bytes, no trailing bits.
  if (bytes.length !== 35 || bits !== 0) {
    return null;
  }

  return {
    versionByte: bytes[0],
    payload: Buffer.from(bytes.slice(1, 33)),
    // The CRC is stored little-endian: low byte first.
    checksum: bytes[33] | (bytes[34] << 8),
  };
}

/**
 * CRC-16/XMODEM, the checksum Stellar's StrKey uses.
 *
 * Seed 0x0000, polynomial 0x1021, no reflection, no final XOR.
 */
export function crc16Xmodem(data: Buffer): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Allowlist contract names, de-duplicated and sorted for stable output. */
function allowlistedContracts(): string[] {
  return [
    ...new Set(ALLOWED_CONTRACT_FUNCTIONS.map((entry) => entry.contract)),
  ].sort();
}

/**
 * Networks a given allowlist contract must be configured for.
 *
 * A contract with only testnet-enabled functions has no mainnet configuration to
 * validate, so demanding one would block a legitimate testnet-only deployment.
 */
function networksFor(contract: string): SorobanNetwork[] {
  const entries = ALLOWED_CONTRACT_FUNCTIONS.filter(
    (entry) => entry.contract === contract,
  );
  const networks: SorobanNetwork[] = [SorobanNetwork.TESTNET];
  if (entries.some((entry) => entry.mainnetEnabled)) {
    networks.push(SorobanNetwork.MAINNET);
  }
  return networks;
}

/**
 * Validates the configured Soroban contract ids at boot.
 *
 * Throws when the invoke surface is enabled and configuration is unusable, so a
 * misconfigured deployment refuses to start rather than failing on the first live
 * invoke. Returns a snapshot (never throws) so the flag can stay off.
 */
@Injectable()
export class SorobanContractBootValidatorService implements OnModuleInit {
  private readonly logger = new Logger(
    SorobanContractBootValidatorService.name,
  );

  /** Invariant 3: only an explicit `true`/`1` enables the surface. */
  isInvokeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env[SOROBAN_INVOKE_ENABLED_ENV];
    return raw === 'true' || raw === '1';
  }

  /**
   * Runs the validation and returns the snapshot without throwing.
   *
   * Separated from {@link onModuleInit} so the whole matrix can be exercised in
   * unit tests without a Nest container.
   */
  validate(env: NodeJS.ProcessEnv = process.env): SorobanContractBootSnapshot {
    const invokeEnabled = this.isInvokeEnabled(env);
    const errors: SorobanContractBootError[] = [];
    const configured: string[] = [];

    for (const contract of allowlistedContracts()) {
      const seen = new Map<SorobanNetwork, string>();
      let contractFailed = false;

      for (const network of networksFor(contract)) {
        const envKey = contractIdEnvKey(contract, network);
        const raw = env[envKey];

        if (raw === undefined || raw === null || String(raw).trim() === '') {
          errors.push({
            code: SOROBAN_CONTRACT_BOOT_ERROR_CODES.CONTRACT_ID_MISSING,
            contract,
            network,
            envKey,
          });
          contractFailed = true;
          continue;
        }

        const value = String(raw).trim();
        if (!isValidContractIdStrKey(value)) {
          errors.push({
            code: SOROBAN_CONTRACT_BOOT_ERROR_CODES.CONTRACT_ID_INVALID,
            contract,
            network,
            envKey,
          });
          contractFailed = true;
          continue;
        }

        // Invariant 2: the same id on both networks is a copy-paste misconfig.
        const other =
          network === SorobanNetwork.MAINNET
            ? SorobanNetwork.TESTNET
            : SorobanNetwork.MAINNET;
        if (seen.get(other) === value) {
          errors.push({
            code: SOROBAN_CONTRACT_BOOT_ERROR_CODES.CONTRACT_ID_NETWORK_COLLISION,
            contract,
            network,
            envKey,
          });
          contractFailed = true;
          continue;
        }

        seen.set(network, value);
      }

      if (!contractFailed) {
        configured.push(contract);
      }
    }

    return {
      // A disabled surface cannot fail on missing configuration: findings are
      // still reported so an operator sees them, but they do not block boot.
      valid: errors.length === 0 || !invokeEnabled,
      nodeEnv: env.NODE_ENV ?? 'development',
      invokeEnabled,
      configured,
      errors,
    };
  }

  /**
   * Boot gate. Throws when the surface is enabled and configuration is invalid.
   *
   * The message names the contract, the network, and the env var to fix — an
   * operator should not have to read the source to learn which variable is
   * wrong. It never includes the configured value.
   */
  onModuleInit(): void {
    const snapshot = this.validate();

    if (!snapshot.invokeEnabled) {
      this.logger.log(
        `Soroban contract boot validation skipped: ${SOROBAN_INVOKE_ENABLED_ENV} ` +
          'is not enabled (no contract ids required)',
      );
      return;
    }

    this.logger.log(
      `Soroban contract boot validation: {"valid":${snapshot.valid},` +
        `"configured":${snapshot.configured.length},` +
        `"errors":${snapshot.errors.length}}`,
    );

    if (snapshot.valid) {
      return;
    }

    const details = snapshot.errors
      .map(
        (error) =>
          `  - [${error.code}] ${error.contract} (${error.network}): ` +
          `set ${error.envKey} to a valid contract id`,
      )
      .join('\n');

    throw new Error(
      [
        'Soroban contract id validation failed:',
        details,
        '',
        `${SOROBAN_INVOKE_ENABLED_ENV}=true requires a distinct, valid contract id`,
        'per network for every allowlisted contract. Set the missing variables, or',
        `set ${SOROBAN_INVOKE_ENABLED_ENV}=false to disable contract invocation.`,
        'See docs/SOROBAN-CONTRACT-ID-BOOT.md.',
      ].join('\n'),
    );
  }
}
