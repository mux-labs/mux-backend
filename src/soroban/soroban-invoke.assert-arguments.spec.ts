import {
  BadRequestException,
  HttpException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { MetricsService } from '../common/metrics/metrics.service';
import { SorobanInvokeService } from './soroban-invoke.service';
import {
  ALLOWED_CONTRACT_FUNCTIONS,
  InvokeErrorCode,
  MAX_INVOKE_ARG_BYTES,
  MAX_INVOKE_ARGS,
  SOROBAN_INVOKE_ENABLED_ENV,
  SorobanNetwork,
} from './soroban-invoke.model';
import type {
  AllowedContractFunction,
  InvokeActor,
} from './soroban-invoke.model';

/** Typed view of the private method under test. */
interface AssertArgumentsInternals {
  assertArguments(
    entry: AllowedContractFunction,
    args: unknown,
    correlationId: string,
  ): void;
}

/**
 * Regression tests for `SorobanInvokeService.assertArguments` (#1340).
 *
 * Documented contract: arity, per-argument Soroban type, count and total
 * serialized size are all checked locally, *before* the network call, so a
 * malformed or oversized request cannot be used to amplify RPC load.
 */
describe('SorobanInvokeService.assertArguments (#1340)', () => {
  const CORRELATION_ID = 'corr-1340';
  const ADDRESS = `G${'A'.repeat(55)}`;

  /** `wallet_registry.register(walletAddress: Address, metadata: Bytes)`. */
  const REGISTER = ALLOWED_CONTRACT_FUNCTIONS.find(
    (entry) =>
      entry.contract === 'wallet_registry' && entry.functionName === 'register',
  ) as AllowedContractFunction;

  let metrics: { incrementCounter: jest.Mock };
  let service: SorobanInvokeService;

  beforeEach(() => {
    metrics = { incrementCounter: jest.fn() };
    service = new SorobanInvokeService(
      undefined,
      undefined,
      metrics as unknown as MetricsService,
    );
  });

  const assertArguments = (
    entry: AllowedContractFunction,
    args: unknown,
  ): void =>
    (service as unknown as AssertArgumentsInternals).assertArguments(
      entry,
      args,
      CORRELATION_ID,
    );

  /** Runs `fn` and returns the HttpException it throws (fails if none). */
  const captureHttpError = (fn: () => unknown): HttpException => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      return err as HttpException;
    }
    throw new Error('expected assertArguments to throw');
  };

  const body = (err: HttpException) =>
    err.getResponse() as {
      code: string;
      message: string;
      correlationId: string;
    };

  it('accepts an argument list that matches the declared signature', () => {
    expect(() =>
      assertArguments(REGISTER, [ADDRESS, 'deadbeef']),
    ).not.toThrow();
    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });

  describe('arity', () => {
    it.each([
      ['too few', [ADDRESS]],
      ['too many', [ADDRESS, 'ab', 'cd']],
      ['none', []],
    ])('rejects %s arguments with ARGUMENT_MISMATCH', (_label, args) => {
      const err = captureHttpError(() => assertArguments(REGISTER, args));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(body(err)).toMatchObject({
        code: InvokeErrorCode.ARGUMENT_MISMATCH,
        correlationId: CORRELATION_ID,
      });
      expect(body(err).message).toContain('expects 2 arguments');
      expect(body(err).message).toContain('walletAddress, metadata');
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'soroban_argument_mismatch',
      );
    });
  });

  describe('per-argument Soroban type', () => {
    it('rejects a non-address in an Address slot', () => {
      const err = captureHttpError(() =>
        assertArguments(REGISTER, ['not-a-stellar-address', 'ab']),
      );

      expect(err).toBeInstanceOf(BadRequestException);
      expect(body(err).code).toBe(InvokeErrorCode.ARGUMENT_MISMATCH);
      expect(body(err).message).toContain('Argument 0 must be Address');
    });

    it('rejects a non-hex string in a Bytes slot', () => {
      const err = captureHttpError(() =>
        assertArguments(REGISTER, [ADDRESS, 'not-hex!']),
      );

      expect(err).toBeInstanceOf(BadRequestException);
      expect(body(err).code).toBe(InvokeErrorCode.ARGUMENT_MISMATCH);
      expect(body(err).message).toContain('Argument 1 must be Bytes');
    });

    it.each([
      ['U32', -1],
      ['U32', 1.5],
      ['U32', '7'],
      ['U64', 7],
      ['U64', '-7'],
      ['Bool', 'true'],
      ['String', 42],
      ['Vec', null],
    ])('rejects %s given %p', (argType, value) => {
      const entry: AllowedContractFunction = {
        contract: 'test',
        functionName: 'typed',
        argTypes: [argType],
        mainnetEnabled: false,
      };

      const err = captureHttpError(() => assertArguments(entry, [value]));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(body(err).code).toBe(InvokeErrorCode.ARGUMENT_MISMATCH);
      expect(body(err).message).toContain(`Argument 0 must be ${argType}`);
    });
  });

  describe('count', () => {
    const boolEntry = (n: number): AllowedContractFunction => ({
      contract: 'test',
      functionName: 'many',
      argTypes: Array.from({ length: n }, () => 'Bool'),
      mainnetEnabled: false,
    });

    it(`accepts exactly MAX_INVOKE_ARGS (${MAX_INVOKE_ARGS}) arguments`, () => {
      const args = Array.from({ length: MAX_INVOKE_ARGS }, () => true);
      expect(() =>
        assertArguments(boolEntry(MAX_INVOKE_ARGS), args),
      ).not.toThrow();
    });

    it('rejects more than MAX_INVOKE_ARGS with REQUEST_TOO_LARGE, even if the signature would match', () => {
      const n = MAX_INVOKE_ARGS + 1;
      const args = Array.from({ length: n }, () => true);

      const err = captureHttpError(() => assertArguments(boolEntry(n), args));

      expect(err).toBeInstanceOf(PayloadTooLargeException);
      expect(body(err)).toMatchObject({
        code: InvokeErrorCode.REQUEST_TOO_LARGE,
        correlationId: CORRELATION_ID,
      });
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'soroban_args_too_many',
      );
    });

    it('checks the count before arity, so an oversized list is refused as too large', () => {
      const args = Array.from({ length: MAX_INVOKE_ARGS + 1 }, () => ADDRESS);

      const err = captureHttpError(() => assertArguments(REGISTER, args));

      expect(err).toBeInstanceOf(PayloadTooLargeException);
      expect(body(err).code).toBe(InvokeErrorCode.REQUEST_TOO_LARGE);
    });
  });

  describe('total serialized size', () => {
    // JSON.stringify([ADDRESS, hex]) === `["<56 chars>","<hex>"]`, i.e. hex + 63.
    const OVERHEAD = JSON.stringify([ADDRESS, '']).length;

    it(`accepts a payload of exactly MAX_INVOKE_ARG_BYTES (${MAX_INVOKE_ARG_BYTES})`, () => {
      const hex = 'a'.repeat(MAX_INVOKE_ARG_BYTES - OVERHEAD);
      expect(JSON.stringify([ADDRESS, hex]).length).toBe(MAX_INVOKE_ARG_BYTES);

      expect(() => assertArguments(REGISTER, [ADDRESS, hex])).not.toThrow();
    });

    it('rejects a payload one byte over MAX_INVOKE_ARG_BYTES with REQUEST_TOO_LARGE', () => {
      const hex = 'a'.repeat(MAX_INVOKE_ARG_BYTES - OVERHEAD + 1);

      const err = captureHttpError(() =>
        assertArguments(REGISTER, [ADDRESS, hex]),
      );

      expect(err).toBeInstanceOf(PayloadTooLargeException);
      expect(body(err)).toMatchObject({
        code: InvokeErrorCode.REQUEST_TOO_LARGE,
        correlationId: CORRELATION_ID,
      });
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'soroban_args_too_large',
      );
    });

    it('rejects an unserializable (circular) payload with INVALID_INPUT', () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const entry: AllowedContractFunction = {
        contract: 'test',
        functionName: 'map',
        argTypes: ['Map'],
        mainnetEnabled: false,
      };

      const err = captureHttpError(() => assertArguments(entry, [circular]));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(body(err).code).toBe(InvokeErrorCode.INVALID_INPUT);
    });
  });

  it('rejects a non-array args value with INVALID_INPUT', () => {
    const err = captureHttpError(() =>
      assertArguments(REGISTER, { 0: ADDRESS, 1: 'ab', length: 2 }),
    );

    expect(err).toBeInstanceOf(BadRequestException);
    expect(body(err).code).toBe(InvokeErrorCode.INVALID_INPUT);
  });

  describe('runs before any network call', () => {
    const originalFlag = process.env[SOROBAN_INVOKE_ENABLED_ENV];

    afterEach(() => {
      if (originalFlag === undefined) {
        delete process.env[SOROBAN_INVOKE_ENABLED_ENV];
      } else {
        process.env[SOROBAN_INVOKE_ENABLED_ENV] = originalFlag;
      }
    });

    it.each([
      ['wrong arity', [ADDRESS]],
      ['wrong type', ['not-an-address', 'ab']],
      ['too many', Array.from({ length: MAX_INVOKE_ARGS + 1 }, () => ADDRESS)],
      ['oversized', [ADDRESS, 'a'.repeat(MAX_INVOKE_ARG_BYTES)]],
    ])(
      'never touches the registry or RPC for a %s argument list',
      async (_label, args) => {
        process.env[SOROBAN_INVOKE_ENABLED_ENV] = 'true';
        const actor: InvokeActor = {
          subjectId: 'owner-1',
          role: 'owner',
          correlationId: CORRELATION_ID,
        };
        const rpc = { simulate: jest.fn(), submit: jest.fn() };
        const registry = { resolveContractId: jest.fn() };
        const wired = new SorobanInvokeService(
          rpc,
          registry,
          metrics as unknown as MetricsService,
        );

        await expect(
          wired.invoke(
            {
              contract: 'wallet_registry',
              functionName: 'register',
              args,
              network: SorobanNetwork.TESTNET,
            },
            actor,
          ),
        ).rejects.toBeInstanceOf(HttpException);

        expect(registry.resolveContractId).not.toHaveBeenCalled();
        expect(rpc.simulate).not.toHaveBeenCalled();
        expect(rpc.submit).not.toHaveBeenCalled();
      },
    );
  });
});
