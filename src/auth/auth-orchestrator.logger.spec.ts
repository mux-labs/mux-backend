import { BadRequestException, Logger } from '@nestjs/common';

import {
  AuthOrchestratorService,
  AuthPayload,
  AuthPayloadValidator,
} from './auth-orchestrator.service';
import { AuthProvider } from './auth-provider.enum';

/**
 * Regression tests for the documented contracts in
 * `auth-orchestrator.service.ts`:
 *
 *  - `AuthPayload` is a *plain payload shape* inspected by
 *    `AuthPayloadValidator` (issue #1335). Rejections are reported through the
 *    Nest `Logger` the service owns.
 *  - `describeProvider` builds a bounded, non-sensitive description of the
 *    offending provider value, never returns the raw value and never touches
 *    other payload fields (issue #1336).
 */

const MAX_LOGGED_PROVIDER_LENGTH = 64;

/**
 * Wraps a payload so every property read is recorded. Used to prove which
 * fields the validator and `describeProvider` actually inspect.
 */
function recordReads<T extends object>(
  target: T,
): { proxy: T; reads: Set<PropertyKey> } {
  const reads = new Set<PropertyKey>();
  const proxy = new Proxy(target, {
    get(obj, key, receiver) {
      reads.add(key);
      return Reflect.get(obj, key, receiver) as unknown;
    },
  });
  return { proxy, reads };
}

describe('AuthPayload plain payload shape (Logger, #1335)', () => {
  let service: AuthOrchestratorService;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new AuthOrchestratorService();
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('accepts a plain object literal without constructing a validator', () => {
    const payload: AuthPayload = {
      authId: 'user_abc',
      authProvider: AuthProvider.CLERK,
    };

    expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    expect(service.validatePayload(payload)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts a prototype-less plain object (no class instance required)', () => {
    const payload = Object.assign(Object.create(null) as AuthPayload, {
      authId: 'user_abc',
      authProvider: AuthProvider.BETTER_AUTH,
    });

    expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    expect(service.validatePayload(payload)).toBe(true);
  });

  it('only inspects the payload: a frozen payload is validated unchanged', () => {
    const payload = Object.freeze({
      authId: 'user_abc',
      email: 'user@example.com',
      displayName: 'User',
      authProvider: AuthProvider.CLERK,
      network: 'testnet',
    });
    const snapshot = { ...payload };

    expect(() => AuthPayloadValidator.validate(payload)).not.toThrow();
    expect(payload).toEqual(snapshot);
  });

  it('inspects only authId and authProvider of the plain shape', () => {
    const { proxy, reads } = recordReads<AuthPayload>({
      authId: 'user_abc',
      email: 'user@example.com',
      displayName: 'User',
      authProvider: AuthProvider.CLERK,
      network: 'testnet',
    });

    AuthPayloadValidator.validate(proxy);

    expect(reads.has('authId')).toBe(true);
    expect(reads.has('authProvider')).toBe(true);
    expect(reads.has('email')).toBe(false);
    expect(reads.has('displayName')).toBe(false);
    expect(reads.has('network')).toBe(false);
  });

  it.each<[string, Partial<AuthPayload> | null | undefined, RegExp]>([
    ['a null payload', null, /Missing auth payload/],
    ['an undefined payload', undefined, /Missing auth payload/],
    ['a missing authProvider', { authId: 'user_abc' }, /Missing authProvider/],
    [
      'a null authProvider',
      { authId: 'user_abc', authProvider: null },
      /Missing authProvider/,
    ],
    [
      'an empty authProvider',
      { authId: 'user_abc', authProvider: '   ' },
      /authProvider must not be empty/,
    ],
    [
      'an unknown authProvider',
      { authId: 'user_abc', authProvider: 'google' },
      /Invalid authProvider/,
    ],
    [
      'a wrong-case authProvider',
      { authId: 'user_abc', authProvider: 'clerk' },
      /Invalid authProvider/,
    ],
  ])('fails closed on %s', (_label, payload, message) => {
    expect(() => AuthPayloadValidator.validate(payload)).toThrow(
      BadRequestException,
    );
    expect(() => AuthPayloadValidator.validate(payload)).toThrow(message);
  });

  it('rejects a non-string authProvider smuggled into the plain shape', () => {
    const payload = {
      authId: 'user_abc',
      authProvider: { $ne: null },
    } as unknown as AuthPayload;

    expect(() => AuthPayloadValidator.validate(payload)).toThrow(
      /authProvider must be a string/,
    );
  });

  it('logs a missing authId through Logger.warn and returns false', () => {
    expect(service.validatePayload({ authProvider: AuthProvider.CLERK })).toBe(
      false,
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('Missing authId in payload');
  });

  it('logs a rejected payload through Logger.warn with the validator message', () => {
    expect(
      service.validatePayload({
        authId: 'user_abc',
        authProvider: 'not-a-real-provider',
      }),
    ).toBe(false);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, context] = warnSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toBe('Invalid authProvider');
    expect(context).toEqual({
      providerType: 'string',
      providerPreview: 'not-a-real-provider',
      error: 'Invalid authProvider',
    });
  });
});

describe('AuthOrchestratorService.describeProvider (#1336)', () => {
  let service: AuthOrchestratorService;

  const describeProvider = (value: unknown): string =>
    (
      service as unknown as { describeProvider(value: unknown): string }
    ).describeProvider(value);

  beforeEach(() => {
    service = new AuthOrchestratorService();
  });

  describe('non-string values are described by type only', () => {
    it.each<[string, unknown, string]>([
      ['undefined', undefined, '<undefined>'],
      ['null', null, '<object>'],
      ['a number', 12345, '<number>'],
      ['a boolean', true, '<boolean>'],
      ['a bigint', BigInt(987654321), '<bigint>'],
      ['a symbol', Symbol('secret-symbol'), '<symbol>'],
      ['a function', () => 'secret-fn', '<function>'],
      ['an operator object', { $ne: 'secret-operator' }, '<object>'],
      ['an array', ['secret-array-item'], '<object>'],
    ])('%s -> %s', (_label, value, expected) => {
      expect(describeProvider(value)).toBe(expected);
    });

    it('never stringifies the raw non-string value', () => {
      const secret = 'sk_live_should_never_be_logged';
      const value = {
        token: secret,
        toString: () => secret,
        toJSON: () => secret,
      };

      const description = describeProvider(value);

      expect(description).toBe('<object>');
      expect(description).not.toContain(secret);
    });

    it('never reads any field of an object value', () => {
      const value = new Proxy(
        {},
        {
          get() {
            throw new Error('describeProvider must not read object fields');
          },
        },
      );

      expect(describeProvider(value)).toBe('<object>');
    });
  });

  describe('string values are bounded', () => {
    it('returns a short string as its own preview', () => {
      expect(describeProvider('not-a-real-provider')).toBe(
        'not-a-real-provider',
      );
    });

    it('does not truncate a string exactly at the limit', () => {
      const atLimit = 'p'.repeat(MAX_LOGGED_PROVIDER_LENGTH);

      expect(describeProvider(atLimit)).toBe(atLimit);
    });

    it('truncates a string one past the limit and marks it with an ellipsis', () => {
      const overLimit = 'p'.repeat(MAX_LOGGED_PROVIDER_LENGTH + 1);

      expect(describeProvider(overLimit)).toBe(
        `${'p'.repeat(MAX_LOGGED_PROVIDER_LENGTH)}…`,
      );
    });

    it('never returns the raw value of an oversized string', () => {
      const tail = 'SECRET_TAIL_THAT_MUST_NOT_BE_LOGGED';
      const huge = `${'x'.repeat(10_000)}${tail}`;

      const description = describeProvider(huge);

      expect(description).not.toBe(huge);
      expect(description).not.toContain(tail);
      expect(description).toHaveLength(MAX_LOGGED_PROVIDER_LENGTH + 1);
      expect(description.endsWith('…')).toBe(true);
    });
  });

  describe('as used by validatePayload', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
      warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('logs a bounded preview of an oversized provider', () => {
      const tail = 'SECRET_TAIL_THAT_MUST_NOT_BE_LOGGED';
      const huge = `${'x'.repeat(10_000)}${tail}`;

      expect(
        service.validatePayload({ authId: 'user_abc', authProvider: huge }),
      ).toBe(false);

      const [, context] = warnSpy.mock.calls[0] as [
        string,
        { providerPreview: string },
      ];
      expect(context.providerPreview).toHaveLength(
        MAX_LOGGED_PROVIDER_LENGTH + 1,
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(tail);
    });

    it('logs only the type of a non-string provider', () => {
      const secret = 'operator-secret-value';

      expect(
        service.validatePayload({
          authId: 'user_abc',
          authProvider: { $ne: secret },
        } as unknown as AuthPayload),
      ).toBe(false);

      const [, context] = warnSpy.mock.calls[0] as [
        string,
        { providerPreview: string },
      ];
      expect(context.providerPreview).toBe('<object>');
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
    });

    it('never touches the other payload fields while describing the provider', () => {
      const { proxy, reads } = recordReads<AuthPayload>({
        authId: 'user_abc',
        email: 'sensitive-user@example.com',
        displayName: 'Sensitive User',
        network: 'mainnet',
        authProvider: 'not-a-real-provider',
      });

      expect(service.validatePayload(proxy)).toBe(false);

      expect(reads.has('email')).toBe(false);
      expect(reads.has('displayName')).toBe(false);
      expect(reads.has('network')).toBe(false);

      const serialized = JSON.stringify(warnSpy.mock.calls);
      expect(serialized).not.toContain('user_abc');
      expect(serialized).not.toContain('sensitive-user@example.com');
      expect(serialized).not.toContain('Sensitive User');
    });
  });
});
