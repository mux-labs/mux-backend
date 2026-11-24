import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import type { MetricsService } from '../common/metrics/metrics.service';
import { SorobanInvokeService } from './soroban-invoke.service';
import {
  InvokeErrorCode,
  MAX_INVOKE_FEE_STROOPS,
  MIN_INVOKE_FEE_STROOPS,
} from './soroban-invoke.model';

const CORRELATION_ID = 'corr-validation-1';

/** A syntactically valid Stellar public key: `G` + 55 base32 characters. */
const VALID_ADDRESS = `G${'A'.repeat(55)}`;

/** Typed view of the private validators under test. */
interface ValidationInternals {
  assertArgumentType(
    expected: string,
    arg: unknown,
    index: number,
    correlationId: string,
  ): void;
  resolveFee(requested: unknown, correlationId: string): string;
}

const buildService = () => {
  const metrics = { incrementCounter: jest.fn() };
  const service = new SorobanInvokeService(
    undefined,
    undefined,
    metrics as unknown as MetricsService,
  );
  return {
    internals: service as unknown as ValidationInternals,
    metrics,
  };
};

/** Captures the HTTP exception thrown by `fn`, failing the test otherwise. */
const captureError = (fn: () => unknown): HttpException => {
  try {
    fn();
  } catch (err) {
    if (err instanceof HttpException) {
      return err;
    }
    throw err;
  }
  throw new Error('expected the call to throw');
};

describe('SorobanInvokeService.assertArgumentType', () => {
  let internals: ValidationInternals;
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    ({ internals, metrics } = buildService());
  });

  const assertArgumentType = (expected: string, arg: unknown, index = 0) =>
    internals.assertArgumentType(expected, arg, index, CORRELATION_ID);

  describe('accepts well-shaped arguments', () => {
    it.each<[string, unknown]>([
      ['Address', VALID_ADDRESS],
      ['U32', 0],
      ['U32', 42],
      ['I32', 7],
      ['U64', '0'],
      ['U64', '18446744073709551615'],
      ['I64', '9007199254740993'],
      ['Bool', true],
      ['Bool', false],
      ['String', 'hello'],
      ['Symbol', 'transfer'],
      ['Bytes', ''],
      ['Bytes', 'deadBEEF'],
      ['Vec', []],
      ['Map', { key: 'value' }],
    ])('%s accepts %p', (expected, arg) => {
      expect(() => assertArgumentType(expected, arg)).not.toThrow();
    });
  });

  describe('rejects the obviously wrong shapes locally', () => {
    it('rejects a negative U32 with ARGUMENT_MISMATCH', () => {
      const err = captureError(() => assertArgumentType('U32', -1, 2));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        code: InvokeErrorCode.ARGUMENT_MISMATCH,
        message: 'Argument 2 must be U32: expected a non-negative integer',
        correlationId: CORRELATION_ID,
      });
    });

    it('rejects a non-address Address with ARGUMENT_MISMATCH', () => {
      const err = captureError(() =>
        assertArgumentType('Address', 'not-an-address', 1),
      );

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        code: InvokeErrorCode.ARGUMENT_MISMATCH,
        message: 'Argument 1 must be Address: expected a Stellar address',
        correlationId: CORRELATION_ID,
      });
    });

    it.each<[string, unknown]>([
      // Address: secret seeds, wrong length, lowercase, non-string.
      ['Address', `S${'A'.repeat(55)}`],
      ['Address', `G${'A'.repeat(54)}`],
      ['Address', `G${'A'.repeat(56)}`],
      ['Address', VALID_ADDRESS.toLowerCase()],
      ['Address', 12345],
      ['Address', null],
      // 32-bit integers: negative, fractional, stringly-typed, NaN.
      ['U32', -5],
      ['I32', -1],
      ['U32', 1.5],
      ['U32', '10'],
      ['U32', Number.NaN],
      // 64-bit integers must be decimal strings, never lossy JS numbers.
      ['U64', 10],
      ['I64', '-1'],
      ['U64', '1e9'],
      ['U64', ''],
      // Primitive mismatches.
      ['Bool', 'true'],
      ['Bool', 1],
      ['String', 42],
      ['Symbol', undefined],
      ['Bytes', 'xyz'],
      ['Bytes', 0xff],
      ['Vec', null],
      ['Map', 'not-an-object'],
    ])('%s rejects %p', (expected, arg) => {
      const err = captureError(() => assertArgumentType(expected, arg));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: InvokeErrorCode.ARGUMENT_MISMATCH,
        correlationId: CORRELATION_ID,
      });
    });
  });

  it('refuses an unrecognised declared type rather than passing it through', () => {
    const err = captureError(() => assertArgumentType('U256', '1', 3));

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual({
      code: InvokeErrorCode.ARGUMENT_MISMATCH,
      message: 'Argument 3 must be U256: unsupported declared type U256',
      correlationId: CORRELATION_ID,
    });
  });

  it('is a local shape check only and never touches metrics', () => {
    assertArgumentType('U32', 1);
    captureError(() => assertArgumentType('U32', -1));

    expect(metrics.incrementCounter).not.toHaveBeenCalled();
  });
});

describe('SorobanInvokeService.resolveFee', () => {
  let internals: ValidationInternals;
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    ({ internals, metrics } = buildService());
  });

  const resolveFee = (requested: unknown): string =>
    internals.resolveFee(requested, CORRELATION_ID);

  const belowFloor = (BigInt(MIN_INVOKE_FEE_STROOPS) - 1n).toString();
  const aboveCeiling = (BigInt(MAX_INVOKE_FEE_STROOPS) + 1n).toString();

  it.each([undefined, null, ''])(
    'defaults an omitted fee (%p) to the server floor',
    (requested) => {
      expect(resolveFee(requested)).toBe(MIN_INVOKE_FEE_STROOPS);
    },
  );

  it('lets a client lower the fee below the ceiling', () => {
    const lowered = (BigInt(MAX_INVOKE_FEE_STROOPS) / 2n).toString();

    expect(resolveFee(lowered)).toBe(lowered);
  });

  it('accepts the floor and the ceiling exactly', () => {
    expect(resolveFee(MIN_INVOKE_FEE_STROOPS)).toBe(MIN_INVOKE_FEE_STROOPS);
    expect(resolveFee(MAX_INVOKE_FEE_STROOPS)).toBe(MAX_INVOKE_FEE_STROOPS);
  });

  describe('never lets a client raise the fee above the ceiling', () => {
    it('refuses a fee one stroop above the ceiling', () => {
      const err = captureError(() => resolveFee(aboveCeiling));

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: InvokeErrorCode.INVALID_INPUT,
        message: `maxFee must not exceed ${MAX_INVOKE_FEE_STROOPS} stroops`,
        correlationId: CORRELATION_ID,
      });
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'soroban_fee_too_high',
      );
    });

    it('refuses a fee beyond 2^53 instead of losing precision', () => {
      const err = captureError(() => resolveFee('9007199254740993000'));

      expect(err).toBeInstanceOf(ConflictException);
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'soroban_fee_too_high',
      );
    });
  });

  describe('refuses a dust fee below the floor', () => {
    it.each([belowFloor, '0'])('refuses %p with FEE_TOO_LOW', (requested) => {
      const err = captureError(() => resolveFee(requested));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        code: InvokeErrorCode.FEE_TOO_LOW,
        message: `maxFee must be at least ${MIN_INVOKE_FEE_STROOPS} stroops`,
        correlationId: CORRELATION_ID,
      });
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'soroban_fee_too_low',
      );
    });
  });

  it.each(['-500', '1e6', '100.5', 'abc', ' 100'])(
    'refuses a non-decimal fee %p with INVALID_INPUT',
    (requested) => {
      const err = captureError(() => resolveFee(requested));

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual({
        code: InvokeErrorCode.INVALID_INPUT,
        message: 'maxFee must be a decimal string of stroops',
        correlationId: CORRELATION_ID,
      });
    },
  );
});
