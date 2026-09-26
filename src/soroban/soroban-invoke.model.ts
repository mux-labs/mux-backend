import { randomUUID } from 'crypto';

/**
 * Soroban invoke orchestration: the rules for calling a smart contract on
 * behalf of a wallet.
 *
 * The backend is the orchestrator: the client asks for an intent, and the server
 * decides whether it is allowed, builds the transaction, and signs it with the
 * wallet's custody key. A client never supplies a pre-signed transaction, a
 * contract the server has not allowlisted, or an argument list the server has
 * not bounds-checked.
 */

/** Lifecycle of an orchestrated invoke. */
export const InvokeStatus = {
  /** Accepted and simulated successfully; not yet submitted. */
  SIMULATED: 'SIMULATED',
  /** Submitted to the network. */
  SUBMITTED: 'SUBMITTED',
  /** Simulation predicted a failure; nothing was submitted. */
  FAILED: 'FAILED',
} as const;

export type InvokeStatus = (typeof InvokeStatus)[keyof typeof InvokeStatus];

/** Networks a contract invocation may target. */
export const SorobanNetwork = {
  TESTNET: 'TESTNET',
  MAINNET: 'MAINNET',
} as const;

export type SorobanNetwork =
  (typeof SorobanNetwork)[keyof typeof SorobanNetwork];

/** A contract function the backend is willing to invoke. */
export interface AllowedContractFunction {
  /** Contract name, as registered in the allowlist. */
  contract: string;
  /** Exported function name. */
  functionName: string;
  /** Soroban value type of each argument, in positional order. */
  argTypes: string[];
  /** Argument names, used only for error messages. Never used for dispatch. */
  argNames?: string[];
  /** Whether this function may be invoked on mainnet. */
  mainnetEnabled: boolean;
}

/** A fully-resolved invoke request. */
export interface InvokeRequest {
  /** Allowlist name of the contract, never a raw contract id. */
  contract: string;
  functionName: string;
  args: unknown[];
  network: SorobanNetwork;
  /** Simulation only: build and check the transaction without submitting. */
  simulateOnly?: boolean;
  /** Maximum fee the server may attach, in stroops. */
  maxFee?: string;
}

/** Result of an orchestrated invoke. Carries no key material. */
export interface InvokeResult {
  invokeId: string;
  status: InvokeStatus;
  contract: string;
  functionName: string;
  network: SorobanNetwork;
  /** Simulated footprint / resource estimate, when available. */
  estimatedCost?: string;
  /** Transaction hash once submitted. */
  transactionHash?: string;
  /** Stable machine-readable failure code when status is FAILED. */
  errorCode?: string;
  correlationId: string;
}

/** Generates a correlation id when the client did not supply a usable one. */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Stable, typed error codes for Soroban invoke orchestration.
 *
 * Clients branch on these, not on messages. Add new codes; never repurpose one.
 */
export const InvokeErrorCode = {
  /** Malformed request: bad contract, function, args, fee, or network. */
  INVALID_INPUT: 'SOROBAN_INVOKE_INVALID_INPUT',

  /** The contract name is not in the allowlist. */
  CONTRACT_NOT_ALLOWED: 'SOROBAN_CONTRACT_NOT_ALLOWED',

  /** The contract exists but this function is not allowlisted on it. */
  FUNCTION_NOT_ALLOWED: 'SOROBAN_FUNCTION_NOT_ALLOWED',

  /** The function exists but is not enabled on mainnet. */
  FUNCTION_NOT_ENABLED: 'SOROBAN_FUNCTION_NOT_ENABLED',

  /** The argument count or shape does not match the declared signature. */
  ARGUMENT_MISMATCH: 'SOROBAN_ARGUMENT_MISMATCH',

  /** The request exceeds the configured batch or size limits. */
  REQUEST_TOO_LARGE: 'SOROBAN_REQUEST_TOO_LARGE',

  /** The provided max fee is below the server's floor. */
  FEE_TOO_LOW: 'SOROBAN_FEE_TOO_LOW',

  /** Simulation predicted a revert; nothing was submitted. */
  SIMULATION_REVERTED: 'SOROBAN_SIMULATION_REVERTED',

  /** The Soroban RPC is unavailable; the invoke is refused. */
  RPC_UNAVAILABLE: 'SOROBAN_RPC_UNAVAILABLE',

  /** Orchestration is disabled by the feature flag. */
  FEATURE_FLAG_DISABLED: 'SOROBAN_INVOKE_DISABLED',

  // Authz (deny-by-default)
  NOT_AUTHORIZED: 'SOROBAN_INVOKE_NOT_AUTHORIZED',
  INSUFFICIENT_ROLE: 'SOROBAN_INSUFFICIENT_ROLE',
} as const;

export type InvokeErrorCode =
  (typeof InvokeErrorCode)[keyof typeof InvokeErrorCode];

/**
 * Env var gating Soroban invoke orchestration. Default OFF (fail-closed):
 * no contract is invoked until an operator has explicitly enabled it.
 */
export const SOROBAN_INVOKE_ENABLED_ENV = 'SOROBAN_INVOKE_ENABLED';

/** Maximum arguments accepted in a single invoke. */
export const MAX_INVOKE_ARGS = 16;

/** Maximum serialized size of the argument list, in bytes. */
export const MAX_INVOKE_ARG_BYTES = 8192;

/** Server-imposed fee floor in stroops, per invocation. */
export const MIN_INVOKE_FEE_STROOPS = '100';

/** Server-imposed fee ceiling in stroops, per invocation. */
export const MAX_INVOKE_FEE_STROOPS = '1000000';

/**
 * The contract/function allowlist.
 *
 * Explicit on purpose. An open "invoke any contract the client names" surface
 * turns the backend into a generic transaction relay for arbitrary third-party
 * code, which is not a wallet. Adding a row is a reviewed decision to support
 * that function.
 *
 * `spend_limit.set_limit` is testnet-only until the contract has been audited on
 * mainnet — the same "exercise on testnet first" discipline the asset matrix
 * uses.
 */
export const ALLOWED_CONTRACT_FUNCTIONS: readonly AllowedContractFunction[] = [
  {
    contract: 'wallet_registry',
    functionName: 'register',
    argTypes: ['Address', 'Bytes'],
    argNames: ['walletAddress', 'metadata'],
    mainnetEnabled: true,
  },
  {
    contract: 'wallet_registry',
    functionName: 'set_spending_policy',
    argTypes: ['Address', 'U32', 'U32', 'Address', 'U64'],
    argNames: [
      'walletAddress',
      'dailyLimit',
      'perTxLimit',
      'asset',
      'validUntil',
    ],
    mainnetEnabled: true,
  },
  {
    contract: 'wallet_registry',
    functionName: 'revoke_delegate',
    argTypes: ['Address', 'Address'],
    argNames: ['walletAddress', 'delegateAddress'],
    mainnetEnabled: true,
  },
  {
    contract: 'spend_limit',
    functionName: 'set_limit',
    argTypes: ['Address', 'U32', 'U32'],
    argNames: ['walletAddress', 'dailyLimit', 'perTxLimit'],
    mainnetEnabled: false,
  },
] as const;

/**
 * Authenticated principal for an invoke.
 *
 * A delegate may invoke only within the limits the owner set; the backend
 * resolves the effective authority, so a client cannot assert it.
 */
export interface InvokeActor {
  subjectId: string;
  role: 'owner' | 'delegate' | 'guardian' | 'api-key';
  correlationId: string;
}
