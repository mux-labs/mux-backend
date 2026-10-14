import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SorobanInvokeService } from './soroban-invoke.service';
import {
  InvokeErrorCode,
  InvokeStatus,
  MAX_INVOKE_FEE_STROOPS,
  MIN_INVOKE_FEE_STROOPS,
  SOROBAN_INVOKE_ENABLED_ENV,
  SorobanNetwork,
} from './soroban-invoke.model';
import type { InvokeActor, InvokeRequest } from './soroban-invoke.model';
import { MetricsService } from '../common/metrics/metrics.service';

const ADDRESS = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const CORRELATION_ID = 'corr-1';
const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

const owner: InvokeActor = {
  subjectId: 'user-owner',
  role: 'owner',
  correlationId: CORRELATION_ID,
};

/** The `simulate` call arguments, typed so assertions read clearly. */
function simulateArgs(rpcPort: {
  simulate: jest.Mock;
}): Record<string, unknown> {
  const calls = rpcPort.simulate.mock.calls as unknown[][];
  return (calls[0]?.[0] ?? {}) as Record<string, unknown>;
}

function revokeRequest(overrides: Partial<InvokeRequest> = {}): InvokeRequest {
  return {
    contract: 'wallet_registry',
    functionName: 'revoke_delegate',
    args: [ADDRESS, ADDRESS],
    network: SorobanNetwork.TESTNET,
    ...overrides,
  };
}

describe('SorobanInvokeService', () => {
  let service: SorobanInvokeService;
  let rpc: { simulate: jest.Mock; submit: jest.Mock };
  let registry: { resolveContractId: jest.Mock };
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    process.env[SOROBAN_INVOKE_ENABLED_ENV] = 'true';
    rpc = {
      simulate: jest
        .fn()
        .mockResolvedValue({ success: true, estimatedCost: '5000' }),
      submit: jest.fn().mockResolvedValue({ transactionHash: 'abc123' }),
    };
    registry = {
      resolveContractId: jest.fn().mockResolvedValue(CONTRACT_ID),
    };
    metrics = { incrementCounter: jest.fn() };

    service = new SorobanInvokeService(
      rpc,
      registry,
      metrics as unknown as MetricsService,
    );
  });

  afterEach(() => {
    delete process.env[SOROBAN_INVOKE_ENABLED_ENV];
    jest.restoreAllMocks();
  });

  describe('happy path', () => {
    it('simulates then submits an allowlisted invoke', async () => {
      const result = await service.invoke(revokeRequest(), owner);

      expect(result.status).toBe(InvokeStatus.SUBMITTED);
      expect(result.transactionHash).toBe('abc123');
      expect(rpc.simulate).toHaveBeenCalledTimes(1);
      expect(rpc.submit).toHaveBeenCalledTimes(1);
    });

    it('always simulates before submitting', async () => {
      await service.invoke(revokeRequest(), owner);

      const simulateOrder = rpc.simulate.mock.invocationCallOrder[0] ?? 0;
      const submitOrder = rpc.submit.mock.invocationCallOrder[0] ?? 0;
      expect(simulateOrder).toBeLessThan(submitOrder);
    });

    it('resolves the contract id server-side rather than trusting the client', async () => {
      await service.invoke(revokeRequest(), owner);

      // The client named a contract; the server resolved the id.
      expect(registry.resolveContractId).toHaveBeenCalledWith(
        'wallet_registry',
        SorobanNetwork.TESTNET,
      );
      expect(simulateArgs(rpc)).toMatchObject({ contractId: CONTRACT_ID });
    });

    it('honours simulateOnly by not submitting', async () => {
      const result = await service.invoke(
        revokeRequest({ simulateOnly: true }),
        owner,
      );

      expect(result.status).toBe(InvokeStatus.SIMULATED);
      expect(result.estimatedCost).toBe('5000');
      expect(rpc.submit).not.toHaveBeenCalled();
    });

    it('echoes a correlation id on the result', async () => {
      const result = await service.invoke(revokeRequest(), owner);
      expect(result.correlationId).toBe(CORRELATION_ID);
    });
  });

  describe('allowlist (deny-by-default)', () => {
    it('refuses a contract that is not allowlisted', async () => {
      await expect(
        service.invoke(revokeRequest({ contract: 'evil_contract' }), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.CONTRACT_NOT_ALLOWED },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses a function that is not allowlisted on an allowed contract', async () => {
      // Distinct from an unknown contract: we know it, but do not expose it.
      await expect(
        service.invoke(revokeRequest({ functionName: 'drain_wallet' }), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.FUNCTION_NOT_ALLOWED },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses a raw contract id supplied in place of a name', async () => {
      // The allowlist is keyed by name; a raw id can never match.
      await expect(
        service.invoke(revokeRequest({ contract: CONTRACT_ID }), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.INVALID_INPUT },
      });
    });
  });

  describe('network enforcement (testnet vs mainnet misconfig)', () => {
    it('refuses a testnet-only function on mainnet', async () => {
      await expect(
        service.invoke(
          {
            contract: 'spend_limit',
            functionName: 'set_limit',
            args: [ADDRESS, 1000, 100],
            network: SorobanNetwork.MAINNET,
          },
          owner,
        ),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.FUNCTION_NOT_ENABLED },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('allows the same function on testnet', async () => {
      const result = await service.invoke(
        {
          contract: 'spend_limit',
          functionName: 'set_limit',
          args: [ADDRESS, 1000, 100],
          network: SorobanNetwork.TESTNET,
        },
        owner,
      );

      expect(result.status).toBe(InvokeStatus.SUBMITTED);
    });

    it('lists only mainnet-enabled functions for mainnet', () => {
      const mainnet = service.listAllowedFunctions(SorobanNetwork.MAINNET);
      expect(mainnet.every((entry) => entry.mainnetEnabled)).toBe(true);
    });
  });

  describe('simulate before submit', () => {
    it('reports a simulated revert without submitting', async () => {
      rpc.simulate.mockResolvedValue({
        success: false,
        revertCode: 'Unauthorized',
      });

      const result = await service.invoke(revokeRequest(), owner);

      expect(result.status).toBe(InvokeStatus.FAILED);
      expect(result.errorCode).toBe(InvokeErrorCode.SIMULATION_REVERTED);
      // The decisive assertion: a failed simulation must never be submitted.
      expect(rpc.submit).not.toHaveBeenCalled();
    });
  });

  describe('dependency outage (fail-closed)', () => {
    it('refuses the invoke when the RPC is unavailable', async () => {
      rpc.simulate.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        service.invoke(revokeRequest(), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.RPC_UNAVAILABLE },
      });
      // Must not fall through to submitting an unsimulated transaction.
      expect(rpc.submit).not.toHaveBeenCalled();
    });

    it('refuses the invoke when the contract registry is unavailable', async () => {
      registry.resolveContractId.mockRejectedValue(new Error('registry down'));

      await expect(
        service.invoke(revokeRequest(), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.RPC_UNAVAILABLE },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses when the registry returns an empty contract id', async () => {
      registry.resolveContractId.mockResolvedValue('');

      await expect(
        service.invoke(revokeRequest(), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.RPC_UNAVAILABLE },
      });
    });
  });

  describe('argument bounds (validated before the network is touched)', () => {
    it('refuses the wrong number of arguments', async () => {
      await expect(
        service.invoke(revokeRequest({ args: [ADDRESS] }), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.ARGUMENT_MISMATCH },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses an argument of the wrong Soroban type', async () => {
      await expect(
        service.invoke(revokeRequest({ args: [ADDRESS, 42] }), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.ARGUMENT_MISMATCH },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses a malformed Address', async () => {
      await expect(
        service.invoke(
          revokeRequest({ args: ['not-an-address', ADDRESS] }),
          owner,
        ),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.ARGUMENT_MISMATCH },
      });
    });

    it('refuses a negative U32', async () => {
      await expect(
        service.invoke(
          {
            contract: 'spend_limit',
            functionName: 'set_limit',
            args: [ADDRESS, -1, 100],
            network: SorobanNetwork.TESTNET,
          },
          owner,
        ),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.ARGUMENT_MISMATCH },
      });
    });

    it('requires U64 values as decimal strings to preserve precision', async () => {
      // set_spending_policy's last arg is U64. A JS number above 2^53 would
      // silently round, so a U64 must arrive as a decimal string.
      const asString: InvokeRequest = {
        contract: 'wallet_registry',
        functionName: 'set_spending_policy',
        args: [ADDRESS, 1000, 100, ADDRESS, '9007199254740993'],
        network: SorobanNetwork.TESTNET,
      };
      await expect(service.invoke(asString, owner)).resolves.toMatchObject({
        status: InvokeStatus.SUBMITTED,
      });
      // 2^53 + 1 as a raw number: accepted as a U32, refused as a U64.
      const asNumber: InvokeRequest = {
        ...asString,
        args: [ADDRESS, 1000, 100, ADDRESS, 1.5],
      };
      await expect(service.invoke(asNumber, owner)).rejects.toMatchObject({
        response: { code: InvokeErrorCode.ARGUMENT_MISMATCH },
      });
    });

    it('refuses too many arguments', async () => {
      await expect(
        service.invoke(
          revokeRequest({ args: new Array(20).fill(ADDRESS) }),
          owner,
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses an oversized argument payload', async () => {
      // A single 9KB Bytes argument passes arity but blows the size budget.
      await expect(
        service.invoke(
          {
            contract: 'wallet_registry',
            functionName: 'register',
            args: [ADDRESS, 'a'.repeat(9000)],
            network: SorobanNetwork.TESTNET,
          },
          owner,
        ),
      ).rejects.toBeInstanceOf(PayloadTooLargeException);
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('rejects before the network is touched at all', async () => {
      // The point of local validation: a malformed request costs nothing.
      await expect(
        service.invoke(revokeRequest({ args: [ADDRESS] }), owner),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(registry.resolveContractId).not.toHaveBeenCalled();
    });
  });

  describe('fee bounds', () => {
    it('defaults to the server floor when no fee is supplied', async () => {
      await service.invoke(revokeRequest(), owner);

      expect(simulateArgs(rpc)).toMatchObject({
        maxFee: MIN_INVOKE_FEE_STROOPS,
      });
    });

    it('refuses a fee below the floor', async () => {
      await expect(
        service.invoke(revokeRequest({ maxFee: '1' }), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.FEE_TOO_LOW },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses a fee above the server ceiling', async () => {
      // A client must not be able to commit the wallet to an arbitrary fee.
      await expect(
        service.invoke(revokeRequest({ maxFee: '999999999999' }), owner),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('refuses a non-numeric fee', async () => {
      await expect(
        service.invoke(revokeRequest({ maxFee: 'lots' }), owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a fee at exactly the ceiling', async () => {
      const result = await service.invoke(
        revokeRequest({ maxFee: MAX_INVOKE_FEE_STROOPS }),
        owner,
      );
      expect(result.status).toBe(InvokeStatus.SUBMITTED);
    });
  });

  describe('authorization (deny-by-default)', () => {
    it('refuses a delegate', async () => {
      const delegate: InvokeActor = {
        subjectId: 'user-delegate',
        role: 'delegate',
        correlationId: CORRELATION_ID,
      };

      await expect(
        service.invoke(revokeRequest(), delegate),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('allows a guardian', async () => {
      const guardian: InvokeActor = {
        subjectId: 'user-guardian',
        role: 'guardian',
        correlationId: CORRELATION_ID,
      };

      await expect(
        service.invoke(revokeRequest(), guardian),
      ).resolves.toMatchObject({
        status: InvokeStatus.SUBMITTED,
      });
    });
  });

  describe('kill-switch', () => {
    it('refuses every invoke when SOROBAN_INVOKE_ENABLED is unset', async () => {
      delete process.env[SOROBAN_INVOKE_ENABLED_ENV];

      await expect(
        service.invoke(revokeRequest(), owner),
      ).rejects.toMatchObject({
        response: { code: InvokeErrorCode.FEATURE_FLAG_DISABLED },
      });
      expect(rpc.simulate).not.toHaveBeenCalled();
    });

    it('treats a non-truthy flag value as disabled', () => {
      process.env[SOROBAN_INVOKE_ENABLED_ENV] = 'yes';
      expect(service.isInvokeEnabled()).toBe(false);
    });

    it('still allows discovery of the allowlist while disabled', () => {
      // Read-only discovery is harmless and lets clients render correct UIs.
      delete process.env[SOROBAN_INVOKE_ENABLED_ENV];
      expect(
        service.listAllowedFunctions(SorobanNetwork.MAINNET).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('adversarial input', () => {
    it('rejects a contract name usable for log injection', async () => {
      await expect(
        service.invoke(
          revokeRequest({ contract: 'wallet\nlevel=ERROR' }),
          owner,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(registry.resolveContractId).not.toHaveBeenCalled();
    });

    it('rejects an uppercase contract name', async () => {
      // The allowlist is lowercase; normalising case would create a bypass
      // surface across registries that are case-sensitive.
      await expect(
        service.invoke(revokeRequest({ contract: 'WALLET_REGISTRY' }), owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-array args payload', async () => {
      await expect(
        service.invoke(revokeRequest({ args: 'not-an-array' as never }), owner),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('observability', () => {
    it('never logs invoke arguments', async () => {
      const logSpy = jest
        .spyOn(
          (service as unknown as { logger: { log: (m: string) => void } })
            .logger,
          'log',
        )
        .mockImplementation(() => undefined);

      await service.invoke(revokeRequest(), owner);

      const logged = logSpy.mock.calls.flat().join(' ');
      expect(logged).not.toContain(ADDRESS);
    });

    it('emits a metric when the kill-switch blocks an invoke', async () => {
      delete process.env[SOROBAN_INVOKE_ENABLED_ENV];

      await expect(
        service.invoke(revokeRequest(), owner),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'soroban_invoke_blocked_by_flag',
      );
    });
  });
});
