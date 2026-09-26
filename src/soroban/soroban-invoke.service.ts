import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MetricsService } from '../common/metrics/metrics.service';
import {
  ALLOWED_CONTRACT_FUNCTIONS,
  InvokeErrorCode,
  InvokeStatus,
  MAX_INVOKE_ARG_BYTES,
  MAX_INVOKE_ARGS,
  MAX_INVOKE_FEE_STROOPS,
  MIN_INVOKE_FEE_STROOPS,
  SOROBAN_INVOKE_ENABLED_ENV,
  SorobanNetwork,
} from './soroban-invoke.model';
import type {
  AllowedContractFunction,
  InvokeActor,
  InvokeRequest,
  InvokeResult,
} from './soroban-invoke.model';

/** DI token for {@link SorobanRpcPort}. */
export const SOROBAN_RPC = 'SOROBAN_RPC';

/** DI token for {@link ContractRegistryPort}. */
export const CONTRACT_REGISTRY = 'CONTRACT_REGISTRY';

/** A simulated (not submitted) transaction. */
export interface SimulatedTransaction {
  /** Whether the simulation predicts success. */
  success: boolean;
  /** Resource/fee estimate in stroops, when the RPC reported one. */
  estimatedCost?: string;
  /** Machine-readable revert code, when the simulation failed. */
  revertCode?: string;
}

/**
 * Maps an allowlist contract name to a network-scoped contract id.
 *
 * Names are resolved server-side, so a client never supplies a contract id.
 * That is what stops a caller from pointing the orchestrator at an arbitrary
 * deployment of a similarly-named contract.
 */
export interface ContractRegistryPort {
  resolveContractId(contract: string, network: SorobanNetwork): Promise<string>;
}

/** The Soroban RPC surface the orchestrator depends on. */
export interface SorobanRpcPort {
  simulate(params: {
    contractId: string;
    functionName: string;
    args: unknown[];
    network: SorobanNetwork;
    maxFee: string;
  }): Promise<SimulatedTransaction>;
  submit(params: {
    contractId: string;
    functionName: string;
    args: unknown[];
    network: SorobanNetwork;
    maxFee: string;
    signedTransaction: string;
  }): Promise<{ transactionHash: string }>;
}

/**
 * Orchestrates a Soroban contract invoke on a wallet's behalf.
 *
 * Invariants:
 *
 * 1. **The backend orchestrates; the client requests.** A client supplies an
 *    intent (allowlisted contract name, function, args). The server resolves the
 *    contract id, bounds-checks the arguments, simulates, and signs with the
 *    custody key. A client can never supply a contract id or a pre-signed
 *    transaction.
 * 2. **Explicit allowlist.** Only `(contract, function)` pairs present in
 *    {@link ALLOWED_CONTRACT_FUNCTIONS} are invocable. There is no
 *    "invoke anything" path: an open surface turns the backend into a generic
 *    relay for arbitrary third-party code.
 * 3. **Arguments are bounds-checked before the network is touched.** Arity,
 *    per-argument Soroban type, count and serialized size are all validated
 *    locally, so a malformed request never costs an RPC round trip.
 * 4. **Simulate before submit.** Every invoke is simulated first. A predicted
 *    revert returns a failure with `SOROBAN_SIMULATION_REVERTED` and **nothing
 *    is submitted** — a failed simulation must never become a submitted
 *    transaction.
 * 5. **Fee bounds are server-side.** A client may lower the fee it will pay but
 *    never raise it: a `maxFee` above the server ceiling is refused, and one
 *    below the floor cannot be used to grief the network with a dust invoke.
 * 6. **Network is enforced.** A function with `mainnetEnabled: false` is refused
 *    on mainnet, so an unaudited contract cannot be driven at mainnet value.
 * 7. **Deny-by-default authz and kill-switch.** `SOROBAN_INVOKE_ENABLED`
 *    defaults to off.
 * 8. **Fail-closed on RPC outage.** An unreachable RPC refuses the invoke; it
 *    never falls through to submitting an unsimulated transaction.
 * 9. **No key material in logs or responses.** Only contract names, function
 *    names, ids and correlation ids are emitted.
 */
@Injectable()
export class SorobanInvokeService {
  private readonly logger = new Logger(SorobanInvokeService.name);

  constructor(
    @Inject(SOROBAN_RPC)
    private readonly rpc: SorobanRpcPort,
    @Inject(CONTRACT_REGISTRY)
    private readonly registry: ContractRegistryPort,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Whether invoke orchestration is enabled. Fail-closed: only an explicit
   * `true`/`1` enables it.
   */
  isInvokeEnabled(): boolean {
    const raw = process.env[SOROBAN_INVOKE_ENABLED_ENV];
    return raw === 'true' || raw === '1';
  }

  /** The allowlisted functions usable on a network, for client discovery. */
  listAllowedFunctions(network: SorobanNetwork): AllowedContractFunction[] {
    return network === SorobanNetwork.MAINNET
      ? ALLOWED_CONTRACT_FUNCTIONS.filter((entry) => entry.mainnetEnabled)
      : [...ALLOWED_CONTRACT_FUNCTIONS];
  }

  /**
   * Orchestrates one contract invoke.
   *
   * Validates locally, simulates, and only then submits. Every failure path
   * leaves the chain untouched.
   */
  async invoke(
    request: InvokeRequest,
    actor: InvokeActor,
  ): Promise<InvokeResult> {
    const correlationId = actor.correlationId;
    this.assertEnabled(correlationId);
    this.assertAuthorized(actor, correlationId);

    // Local validation runs before any network call, so a malformed request
    // cannot be used to amplify RPC load.
    const entry = this.resolveAllowedFunction(request, correlationId);
    this.assertNetworkAllowed(entry, request.network, correlationId);
    this.assertArguments(entry, request.args, correlationId);
    const maxFee = this.resolveFee(request.maxFee, correlationId);

    const contractId = await this.resolveContractId(
      request.contract,
      request.network,
      correlationId,
    );

    const base = {
      invokeId: randomUUID(),
      contract: request.contract,
      functionName: request.functionName,
      network: request.network,
      correlationId,
    };

    // Simulate first. A predicted revert must never be submitted.
    let simulation: SimulatedTransaction;
    try {
      simulation = await this.rpc.simulate({
        contractId,
        functionName: request.functionName,
        args: request.args,
        network: request.network,
        maxFee,
      });
    } catch (err) {
      this.metrics.incrementCounter('soroban_rpc_unavailable');
      this.logger.error(
        `soroban.invoke rpc failure contract=${request.contract} ` +
          `fn=${request.functionName} correlationId=${correlationId} ` +
          `reason=${this.errorName(err)}`,
      );
      throw new ServiceUnavailableException({
        code: InvokeErrorCode.RPC_UNAVAILABLE,
        message: 'Soroban RPC unavailable; invoke refused',
        correlationId,
      });
    }

    if (!simulation?.success) {
      this.metrics.incrementCounter('soroban_simulation_reverted');
      this.logger.warn(
        `soroban.invoke simulated revert contract=${request.contract} ` +
          `fn=${request.functionName} correlationId=${correlationId}`,
      );
      return {
        ...base,
        status: InvokeStatus.FAILED,
        errorCode: InvokeErrorCode.SIMULATION_REVERTED,
      };
    }

    if (request.simulateOnly) {
      this.metrics.incrementCounter('soroban_simulate_only');
      return {
        ...base,
        status: InvokeStatus.SIMULATED,
        estimatedCost: simulation.estimatedCost,
      };
    }

    // Submission is delegated to the custody layer, which signs with the
    // wallet key. The orchestrator never handles key material itself.
    const { transactionHash } = await this.rpc.submit({
      contractId,
      functionName: request.functionName,
      args: request.args,
      network: request.network,
      maxFee,
      signedTransaction: '',
    });

    this.metrics.incrementCounter('soroban_invoke_submitted');
    // Contract and function names only — never arguments or key material.
    this.logger.log(
      `soroban.invoke submitted contract=${request.contract} ` +
        `fn=${request.functionName} network=${request.network} ` +
        `correlationId=${correlationId}`,
    );

    return {
      ...base,
      status: InvokeStatus.SUBMITTED,
      transactionHash,
      estimatedCost: simulation.estimatedCost,
    };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Deny-by-default gate. Nothing is invoked until an operator opts in.
   */
  private assertEnabled(correlationId: string): void {
    if (this.isInvokeEnabled()) {
      return;
    }
    this.metrics.incrementCounter('soroban_invoke_blocked_by_flag');
    this.logger.warn(
      `soroban.invoke refused: ${SOROBAN_INVOKE_ENABLED_ENV} is not enabled ` +
        `correlationId=${correlationId}`,
    );
    throw new ServiceUnavailableException({
      code: InvokeErrorCode.FEATURE_FLAG_DISABLED,
      message: `Soroban invoke is disabled; set ${SOROBAN_INVOKE_ENABLED_ENV}=true to enable`,
      correlationId,
    });
  }

  /**
   * Invoking is owner/guardian/api-key only. A delegate is refused outright:
   * the owner's spending policy bounds what a delegate may *move*, whereas this
   * surface changes contract state, so it is not delegated by default.
   */
  private assertAuthorized(actor: InvokeActor, correlationId: string): void {
    if (
      actor.role === 'owner' ||
      actor.role === 'guardian' ||
      actor.role === 'api-key'
    ) {
      return;
    }
    this.metrics.incrementCounter('soroban_invoke_authz_denied');
    this.logger.warn(
      `soroban.invoke denied role=${actor.role} correlationId=${correlationId}`,
    );
    throw new ForbiddenException({
      code: InvokeErrorCode.INSUFFICIENT_ROLE,
      message: 'Your role may not invoke contracts',
      correlationId,
    });
  }

  /**
   * Resolves the allowlist entry for the requested contract and function.
   *
   * The two refusals are deliberately distinct: `CONTRACT_NOT_ALLOWED` means the
   * contract is unknown to us, `FUNCTION_NOT_ALLOWED` means we know it but do
   * not expose that function. Collapsing them would hide a policy decision
   * behind a generic error.
   */
  private resolveAllowedFunction(
    request: InvokeRequest,
    correlationId: string,
  ): AllowedContractFunction {
    this.assertIdentifier(request.contract, 'contract', correlationId);
    this.assertIdentifier(request.functionName, 'functionName', correlationId);

    const forContract = ALLOWED_CONTRACT_FUNCTIONS.filter(
      (entry) => entry.contract === request.contract,
    );

    if (forContract.length === 0) {
      this.metrics.incrementCounter('soroban_contract_not_allowed');
      throw new ForbiddenException({
        code: InvokeErrorCode.CONTRACT_NOT_ALLOWED,
        message: `Contract ${request.contract} is not available`,
        correlationId,
      });
    }

    const entry = forContract.find(
      (candidate) => candidate.functionName === request.functionName,
    );
    if (!entry) {
      this.metrics.incrementCounter('soroban_function_not_allowed');
      throw new ForbiddenException({
        code: InvokeErrorCode.FUNCTION_NOT_ALLOWED,
        message: `Function ${request.functionName} is not available on ${request.contract}`,
        correlationId,
      });
    }

    return entry;
  }

  /**
   * Refuses a testnet-only function on mainnet. This is the guard that keeps an
   * unaudited contract from being driven at mainnet value.
   */
  private assertNetworkAllowed(
    entry: AllowedContractFunction,
    network: SorobanNetwork,
    correlationId: string,
  ): void {
    if (network !== SorobanNetwork.MAINNET || entry.mainnetEnabled) {
      return;
    }
    this.metrics.incrementCounter('soroban_function_not_enabled');
    throw new ForbiddenException({
      code: InvokeErrorCode.FUNCTION_NOT_ENABLED,
      message: `${entry.contract}.${entry.functionName} is not enabled on MAINNET`,
      correlationId,
    });
  }

  /**
   * Bounds-checks the argument list against the declared signature.
   *
   * Arity, per-argument Soroban type, count and total serialized size are all
   * checked locally. Doing this before the network call is what stops a
   * malformed or oversized request from being used to amplify RPC load.
   */
  private assertArguments(
    entry: AllowedContractFunction,
    args: unknown[],
    correlationId: string,
  ): void {
    if (!Array.isArray(args)) {
      throw new BadRequestException({
        code: InvokeErrorCode.INVALID_INPUT,
        message: 'args must be an array',
        correlationId,
      });
    }

    if (args.length > MAX_INVOKE_ARGS) {
      this.metrics.incrementCounter('soroban_args_too_many');
      throw new PayloadTooLargeException({
        code: InvokeErrorCode.REQUEST_TOO_LARGE,
        message: `At most ${MAX_INVOKE_ARGS} arguments are accepted`,
        correlationId,
      });
    }

    if (args.length !== entry.argTypes.length) {
      this.metrics.incrementCounter('soroban_argument_mismatch');
      const expected = entry.argNames?.join(', ') ?? entry.argTypes.join(', ');
      throw new BadRequestException({
        code: InvokeErrorCode.ARGUMENT_MISMATCH,
        message:
          `${entry.functionName} expects ${entry.argTypes.length} arguments (${expected}), ` +
          `received ${args.length}`,
        correlationId,
      });
    }

    args.forEach((arg, index) => {
      this.assertArgumentType(entry.argTypes[index], arg, index, correlationId);
    });

    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      // A circular or unserializable payload would otherwise throw deep inside
      // the RPC client with an opaque error.
      throw new BadRequestException({
        code: InvokeErrorCode.INVALID_INPUT,
        message: 'args must be JSON-serializable',
        correlationId,
      });
    }

    if (serialized.length > MAX_INVOKE_ARG_BYTES) {
      this.metrics.incrementCounter('soroban_args_too_large');
      throw new PayloadTooLargeException({
        code: InvokeErrorCode.REQUEST_TOO_LARGE,
        message: `Arguments exceed ${MAX_INVOKE_ARG_BYTES} bytes`,
        correlationId,
      });
    }
  }

  /**
   * Validates one argument against its declared Soroban type.
   *
   * A shape check, not a full XDR encoder: it rejects the obviously wrong shapes
   * (a negative `U32`, a non-address `Address`) so a malformed request fails
   * locally, while the simulation remains the authority on whether the call
   * would actually succeed.
   */
  private assertArgumentType(
    expected: string,
    arg: unknown,
    index: number,
    correlationId: string,
  ): void {
    const reject = (detail: string): never => {
      throw new BadRequestException({
        code: InvokeErrorCode.ARGUMENT_MISMATCH,
        message: `Argument ${index} must be ${expected}: ${detail}`,
        correlationId,
      });
    };

    switch (expected) {
      case 'Address':
        if (typeof arg !== 'string' || !/^G[A-Z2-7]{55}$/.test(arg)) {
          reject('expected a Stellar address');
        }
        return;
      case 'U32':
      case 'I32':
        if (typeof arg !== 'number' || !Number.isInteger(arg) || arg < 0) {
          reject('expected a non-negative integer');
        }
        return;
      case 'U64':
      case 'I64':
        // 64-bit values are decimal strings: a JS number loses precision above
        // 2^53, which for a u64 is a real amount of money.
        if (typeof arg !== 'string' || !/^\d+$/.test(arg)) {
          reject('expected a decimal string');
        }
        return;
      case 'Bool':
        if (typeof arg !== 'boolean') {
          reject('expected a boolean');
        }
        return;
      case 'String':
      case 'Symbol':
        if (typeof arg !== 'string') {
          reject('expected a string');
        }
        return;
      case 'Bytes':
        if (typeof arg !== 'string' || !/^[0-9a-fA-F]*$/.test(arg)) {
          reject('expected a hex string');
        }
        return;
      case 'Vec':
      case 'Map':
        if (typeof arg !== 'object' || arg === null) {
          reject('expected an object or array');
        }
        return;
      default:
        // An unrecognised declared type is a configuration error, not a client
        // error; refuse rather than passing an unvalidated value through.
        return reject(`unsupported declared type ${expected}`);
    }
  }

  /**
   * Clamps the fee to the server's bounds.
   *
   * A client may lower the fee it will pay but never raise it: accepting an
   * arbitrary `maxFee` would let a caller commit the wallet to a fee the owner
   * never agreed to. A fee below the floor is refused because a dust invoke is
   * a griefing vector against the RPC.
   */
  private resolveFee(
    requested: string | undefined,
    correlationId: string,
  ): string {
    if (requested === undefined || requested === null || requested === '') {
      return MIN_INVOKE_FEE_STROOPS;
    }

    if (!/^\d+$/.test(String(requested))) {
      throw new BadRequestException({
        code: InvokeErrorCode.INVALID_INPUT,
        message: 'maxFee must be a decimal string of stroops',
        correlationId,
      });
    }

    // Compared as BigInt: a fee above 2^53 would lose precision as a number.
    const fee = BigInt(String(requested));
    if (fee < BigInt(MIN_INVOKE_FEE_STROOPS)) {
      this.metrics.incrementCounter('soroban_fee_too_low');
      throw new BadRequestException({
        code: InvokeErrorCode.FEE_TOO_LOW,
        message: `maxFee must be at least ${MIN_INVOKE_FEE_STROOPS} stroops`,
        correlationId,
      });
    }

    if (fee > BigInt(MAX_INVOKE_FEE_STROOPS)) {
      this.metrics.incrementCounter('soroban_fee_too_high');
      throw new ConflictException({
        code: InvokeErrorCode.INVALID_INPUT,
        message: `maxFee must not exceed ${MAX_INVOKE_FEE_STROOPS} stroops`,
        correlationId,
      });
    }

    return String(requested);
  }

  /**
   * Resolves the network-scoped contract id server-side.
   *
   * A registry outage refuses the invoke: proceeding without knowing which
   * contract to call is exactly the case where the orchestrator must not guess.
   */
  private async resolveContractId(
    contract: string,
    network: SorobanNetwork,
    correlationId: string,
  ): Promise<string> {
    try {
      const contractId = await this.registry.resolveContractId(
        contract,
        network,
      );
      if (typeof contractId !== 'string' || contractId.length === 0) {
        throw new Error('registry returned an empty contract id');
      }
      return contractId;
    } catch (err) {
      this.metrics.incrementCounter('soroban_registry_unavailable');
      this.logger.error(
        `soroban.invoke registry failure contract=${contract} network=${network} ` +
          `correlationId=${correlationId} reason=${this.errorName(err)}`,
      );
      throw new ServiceUnavailableException({
        code: InvokeErrorCode.RPC_UNAVAILABLE,
        message: 'Contract registry unavailable; invoke refused',
        correlationId,
      });
    }
  }

  /**
   * Validates a contract or function identifier.
   *
   * Bounded and charset-restricted: these values reach log lines, so an
   * unvalidated identifier is a log-injection vector as well as a lookup hazard.
   */
  private assertIdentifier(
    value: unknown,
    field: string,
    correlationId: string,
  ): void {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
      throw new BadRequestException({
        code: InvokeErrorCode.INVALID_INPUT,
        message: `${field} must be 1-64 lowercase alphanumeric/underscore characters`,
        correlationId,
      });
    }
  }

  /** Class name only — never the message, which may carry RPC detail. */
  private errorName(err: unknown): string {
    return err instanceof Error ? err.constructor.name : 'unknown';
  }
}
