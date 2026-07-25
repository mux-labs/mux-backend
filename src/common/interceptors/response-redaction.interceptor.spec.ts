import { ResponseRedactionInterceptor, redact } from './response-redaction.interceptor';
import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, CallHandler } from '@nestjs/common';
import { of } from 'rxjs';

describe('ResponseRedactionInterceptor', () => {
  let interceptor: ResponseRedactionInterceptor;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ResponseRedactionInterceptor],
    }).compile();
    interceptor = module.get(ResponseRedactionInterceptor);
  });

  describe('redact function', () => {
    it('redacts privateKey at the top level', () => {
      const input = { privateKey: 'SABC123...secret...', publicKey: 'GABC...', userId: 'user-1' };
      const result = redact(input) as typeof input;
      expect(result.privateKey).toBe('[REDACTED]');
      expect(result.publicKey).toBe('GABC...');
      expect(result.userId).toBe('user-1');
    });

    it('redacts encryptedSecret', () => {
      const input = { encryptedSecret: 'encrypted-blob-data-here', publicKey: 'GABC...' };
      const result = redact(input) as typeof input;
      expect(result.encryptedSecret).toBe('[REDACTED]');
      expect(result.publicKey).toBe('GABC...');
    });

    it('redacts nested private keys', () => {
      const input = {
        wallet: { encryptedSecret: 'nested-secret', publicKey: 'GABC...' },
        isNewWallet: true,
      };
      const result = redact(input) as typeof input;
      expect((result.wallet as any).encryptedSecret).toBe('[REDACTED]');
      expect((result.wallet as any).publicKey).toBe('GABC...');
      expect(result.isNewWallet).toBe(true);
    });

    it('redacts long strings (>64 chars) at field values', () => {
      const longHex = 'a'.repeat(100);
      const input = { signature: longHex, short: 'hello' };
      const result = redact(input) as typeof input;
      expect(result.signature).toBe('[REDACTED]');
      expect(result.short).toBe('hello');
    });

    it('redacts arrays of sensitive objects', () => {
      const input = {
        data: [
          { privateKey: 'key1', publicKey: 'pub1' },
          { privateKey: 'key2', publicKey: 'pub2' },
        ],
      };
      const result = redact(input) as typeof input;
      expect((result.data as any[])[0].privateKey).toBe('[REDACTED]');
      expect((result.data as any[])[1].privateKey).toBe('[REDACTED]');
      expect((result.data as any[])[0].publicKey).toBe('pub1');
      expect((result.data as any[])[1].publicKey).toBe('pub2');
    });

    it('handles null and undefined gracefully', () => {
      expect(redact(null)).toBeNull();
      expect(redact(undefined)).toBeUndefined();
    });

    it('passes through primitive values unchanged', () => {
      expect(redact(42)).toBe(42);
      expect(redact(true)).toBe(true);
      expect(redact('short string')).toBe('short string');
    });

    it('redacts apiKey and token fields', () => {
      const input = { apiKey: 'sk-1234567890', token: 'eyJhbGci', data: 'valid' };
      const result = redact(input) as typeof input;
      expect(result.apiKey).toBe('[REDACTED]');
      expect(result.token).toBe('[REDACTED]');
      expect(result.data).toBe('valid');
    });

    it('respects depth limit to avoid stack overflow on circular-ish deep objects', () => {
      const deep: any = { level: { level: { level: { level: { level: {} } } } } };
      deep.level.level.level.level.level.circular = deep;
      expect(() => redact(deep)).not.toThrow();
    });
  });

  describe('interceptor pipeline', () => {
    it('should redact privateKey from response body', (done) => {
      const mockContext = {
        switchToHttp: () => ({
          getRequest: () => ({ method: 'POST', url: '/v1/wallets/orchestration/create', path: '/v1/wallets/orchestration/create' }),
        }),
      } as ExecutionContext;

      const mockCallHandler: CallHandler = {
        handle: () =>
          of({
            wallet: { encryptedSecret: 'some-encrypted-data', publicKey: 'GABC...' },
            privateKey: 'SABC...',
            isNewWallet: true,
          }),
      };

      interceptor.intercept(mockContext, mockCallHandler).subscribe({
        next: (body: any) => {
          expect(body.privateKey).toBe('[REDACTED]');
          expect(body.wallet.encryptedSecret).toBe('[REDACTED]');
          expect(body.wallet.publicKey).toBe('GABC...');
          expect(body.isNewWallet).toBe(true);
          done();
        },
      });
    });
  });
});
