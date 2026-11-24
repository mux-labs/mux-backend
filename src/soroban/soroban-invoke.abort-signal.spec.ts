import { ServiceUnavailableException } from '@nestjs/common';
import type { MetricsService } from '../common/metrics/metrics.service';
import {
  InvokeErrorCode,
  SOROBAN_INVOKE_ENABLED_ENV,
  SorobanNetwork,
} from './soroban-invoke.model';
import type { InvokeActor, InvokeRequest } from './soroban-invoke.model';
import { SorobanInvokeService } from './soroban-invoke.service';
import type {
  ContractRegistryPort,
  SorobanRpcPort,
} from './soroban-invoke.service';

/**
 * Regression coverage for `SorobanInvokeService.rpcAbortSignal`: the request's
 * abort signal is resolved defensively (absent or look-alike values yield
 * `undefined`), and a real signal is what stops the orchestrator from retrying
 * on behalf of a client that has already disconnected.
 */

const ADDRESS = `G${'A'.repeat(55)}`;
const DELEGATE = `G${'B'.repeat(55)}`;

const ACTOR: InvokeActor = {
  subjectId: 'owner-1',
  role: 'owner',
  correlationId: 'corr-abort-1',
};

const baseRequest = (): InvokeRequest => ({
  contract: 'wallet_registry',
  functionName: 'revoke_delegate',
  args: [ADDRESS, DELEGATE],
  network: SorobanNetwork.TESTNET,
});

/** An error shaped like a transient HTTP 503 from an RPC client. */
const transient = (): Error =>
  Object.assign(new Error('service unavailable'), { statusCode: 503 });

/**
 * Builds the service over mock ports. The RPC mocks are returned as standalone
 * functions so assertions never detach a method from its object.
 */
const makeService = (simulate: jest.Mock = jest.fn()) => {
  const submit = jest.fn();
  const rpc: SorobanRpcPort = { simulate, submit };
  const registry: ContractRegistryPort = {
    resolveContractId: jest.fn().mockResolvedValue('CCONTRACTID'),
  };
  const metrics = {
    incrementCounter: jest.fn(),
  } as unknown as MetricsService;
  return {
    service: new SorobanInvokeService(rpc, registry, metrics),
    simulate,
    submit,
  };
};

const rpcAbortSignal = (
  service: SorobanInvokeService,
  request: unknown,
): AbortSignal | undefined =>
  (
    service as unknown as {
      rpcAbortSignal(r: unknown): AbortSignal | undefined;
    }
  ).rpcAbortSignal(request);

describe('SorobanInvokeService.rpcAbortSignal', () => {
  describe('defensive resolution', () => {
    it('returns the runtime-supplied AbortSignal', () => {
      const { service } = makeService();
      const controller = new AbortController();

      expect(
        rpcAbortSignal(service, {
          ...baseRequest(),
          abortSignal: controller.signal,
        }),
      ).toBe(controller.signal);
    });

    it('returns undefined when the runtime supplied none', () => {
      const { service } = makeService();
      expect(rpcAbortSignal(service, baseRequest())).toBeUndefined();
    });

    it.each([
      ['a look-alike object', { aborted: true, addEventListener: () => {} }],
      ['an AbortController (not its signal)', new AbortController()],
      ['a string', 'aborted'],
      ['a boolean', true],
      ['null', null],
    ])('ignores %s in place of a signal', (_label, abortSignal) => {
      const { service } = makeService();
      expect(
        rpcAbortSignal(service, { ...baseRequest(), abortSignal }),
      ).toBeUndefined();
    });
  });

  describe('wiring into the invoke retry loop', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {
        ...originalEnv,
        [SOROBAN_INVOKE_ENABLED_ENV]: 'true',
        SOROBAN_RPC_MAX_ATTEMPTS: '5',
        SOROBAN_RPC_RETRY_BACKOFF_MS: '0',
        SOROBAN_RPC_DEADLINE_MS: '60000',
      };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    const expectRpcUnavailable = async (promise: Promise<unknown>) => {
      const err = await promise.then(
        () => {
          throw new Error('expected the invoke to be refused');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
        code: InvokeErrorCode.RPC_UNAVAILABLE,
      });
    };

    it('does not touch the RPC for a client that has already disconnected', async () => {
      const { service, simulate, submit } = makeService();
      const controller = new AbortController();
      controller.abort();

      await expectRpcUnavailable(
        service.invoke(
          {
            ...baseRequest(),
            abortSignal: controller.signal,
          } as InvokeRequest,
          ACTOR,
        ),
      );

      expect(simulate).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it('stops retrying simulate once the client disconnects', async () => {
      const controller = new AbortController();
      const { service, simulate, submit } = makeService(
        jest.fn().mockImplementation(() => {
          controller.abort();
          return Promise.reject(transient());
        }),
      );

      await expectRpcUnavailable(
        service.invoke(
          {
            ...baseRequest(),
            abortSignal: controller.signal,
          } as InvokeRequest,
          ACTOR,
        ),
      );

      // The policy allows 5 attempts; the abort must cut it to one.
      expect(simulate).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    });

    it('keeps retrying simulate when no signal is supplied (control)', async () => {
      const { service, simulate, submit } = makeService(
        jest.fn().mockRejectedValue(transient()),
      );

      await expectRpcUnavailable(service.invoke(baseRequest(), ACTOR));

      expect(simulate).toHaveBeenCalledTimes(5);
      expect(submit).not.toHaveBeenCalled();
    });
  });
});
