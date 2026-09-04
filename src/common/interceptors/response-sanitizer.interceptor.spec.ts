/**
 * ResponseSanitizerInterceptor — unit tests
 *
 * Covers:
 *  - Strips privateKey from response body
 *  - Strips encryptedSecret from response body
 *  - Strips nested sensitive fields
 *  - Passes through non-sensitive fields unchanged
 *  - Handles null/undefined responses
 *  - Handles array responses
 */
import { ResponseSanitizerInterceptor } from './response-sanitizer.interceptor';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';
import { firstValueFrom } from 'rxjs';

describe('ResponseSanitizerInterceptor', () => {
  let interceptor: ResponseSanitizerInterceptor;

  beforeEach(() => {
    interceptor = new ResponseSanitizerInterceptor();
  });

  function mockContext(): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({}),
        getResponse: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as ExecutionContext;
  }

  function callHandler(responseBody: unknown): CallHandler {
    return { handle: () => of(responseBody) };
  }

  it('strips privateKey from the response body', async () => {
    const body = {
      wallet: { id: 'wallet-1', publicKey: 'GABC' },
      privateKey: 'S-secret-key',
      isNewWallet: true,
    };

    const result = await firstValueFrom(
      interceptor.intercept(mockContext(), callHandler(body)),
    );

    expect(result.privateKey).toBe('[REDACTED]');
    expect(result.wallet.id).toBe('wallet-1');
    expect(result.isNewWallet).toBe(true);
  });

  it('strips encryptedSecret from the response body', async () => {
    const body = {
      wallet: {
        id: 'wallet-1',
        encryptedSecret: 'enc-very-secret',
        publicKey: 'GABC',
      },
    };

    const result = await firstValueFrom(
      interceptor.intercept(mockContext(), callHandler(body)),
    );

    expect(result.wallet.encryptedSecret).toBe('[REDACTED]');
    expect(result.wallet.publicKey).toBe('GABC');
  });

  it('strips nested sensitive fields deep in the response', async () => {
    const body = {
      data: {
        items: [
          { privateKey: 'S-key-1', name: 'item1' },
          { encryptedSecret: 'enc-2', name: 'item2' },
        ],
      },
    };

    const result = await firstValueFrom(
      interceptor.intercept(mockContext(), callHandler(body)),
    );

    expect(result.data.items[0].privateKey).toBe('[REDACTED]');
    expect(result.data.items[0].name).toBe('item1');
    expect(result.data.items[1].encryptedSecret).toBe('[REDACTED]');
    expect(result.data.items[1].name).toBe('item2');
  });

  it('passes through non-sensitive fields unchanged', async () => {
    const body = {
      wallet: { id: 'w-1', publicKey: 'GABC', status: 'ACTIVE' },
      isNewWallet: false,
      idempotencyKey: 'key-123',
    };

    const result = await firstValueFrom(
      interceptor.intercept(mockContext(), callHandler(body)),
    );

    expect(result.wallet.id).toBe('w-1');
    expect(result.wallet.publicKey).toBe('GABC');
    expect(result.wallet.status).toBe('ACTIVE');
    expect(result.isNewWallet).toBe(false);
    expect(result.idempotencyKey).toBe('key-123');
  });

  it('handles null and undefined responses', async () => {
    const nullResult = await firstValueFrom(
      interceptor.intercept(mockContext(), callHandler(null)),
    );
    expect(nullResult).toBeNull();

    const undefinedResult = await firstValueFrom(
      interceptor.intercept(mockContext(), callHandler(undefined)),
    );
    expect(undefinedResult).toBeUndefined();
  });

  it('handles array responses', async () => {
    const body = [
      { privateKey: 'S-key-1', publicKey: 'GABC' },
      { privateKey: 'S-key-2', publicKey: 'GDEF' },
    ];

    const result = await firstValueFrom(
      interceptor.intercept(mockContext(), callHandler(body)),
    );

    expect(result[0].privateKey).toBe('[REDACTED]');
    expect(result[0].publicKey).toBe('GABC');
    expect(result[1].privateKey).toBe('[REDACTED]');
    expect(result[1].publicKey).toBe('GDEF');
  });
});
