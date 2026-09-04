import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  WebhookSignatureGuard,
  WEBHOOK_SIGNATURE_HEADER,
} from './webhook-signature.guard';
import { WebhookSignerService } from './webhook-signer.service';

describe('WebhookSignatureGuard', () => {
  let guard: WebhookSignatureGuard;
  let signer: WebhookSignerService;
  let configService: jest.Mocked<ConfigService>;

  const secret = 'test-inbound-secret';

  beforeEach(() => {
    signer = new WebhookSignerService();
    configService = {
      get: jest.fn().mockReturnValue(secret),
    } as unknown as jest.Mocked<ConfigService>;
    guard = new WebhookSignatureGuard(signer, configService);
  });

  const makeCtx = (
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): ExecutionContext => {
    const request = {
      headers,
      body,
      method: 'POST',
      path: '/webhooks/inbound',
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;
  };

  const sign = (payload: unknown, ts: number) => {
    const payloadString = JSON.stringify(payload);
    const signature = signer.signPayload(payloadString, secret, ts);
    return signer.formatSignatureHeader(ts, signature);
  };

  // ---------------------------------------------------------------------------
  // Success path — valid signature is accepted
  // ---------------------------------------------------------------------------

  it('should allow the request through when the signature is valid', () => {
    const body = { event: 'wallet.created', id: 'evt-1' };
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(body, ts);

    const ctx = makeCtx({ [WEBHOOK_SIGNATURE_HEADER]: header }, body);

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should verify against the raw body when present, not the parsed body', () => {
    const rawPayload = '{"event":"wallet.created","id":"evt-1"}';
    const ts = Math.floor(Date.now() / 1000);
    const signature = signer.signPayload(rawPayload, secret, ts);
    const header = signer.formatSignatureHeader(ts, signature);

    const request = {
      headers: { [WEBHOOK_SIGNATURE_HEADER]: header },
      body: { event: 'wallet.created', id: 'evt-1' },
      rawBody: Buffer.from(rawPayload, 'utf8'),
      method: 'POST',
      path: '/webhooks/inbound',
    };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    } as unknown as ExecutionContext;

    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Failure path — missing signature header
  // ---------------------------------------------------------------------------

  it('should reject with 401 when the signature header is missing', () => {
    const ctx = makeCtx({}, { event: 'wallet.created' });

    expect(() => guard.canActivate(ctx)).toThrow(HttpException);

    try {
      guard.canActivate(ctx);
      fail('expected canActivate to throw');
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect(err.getResponse()).toEqual({
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid webhook signature',
        error: 'Unauthorized',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Failure path — malformed signature header
  // ---------------------------------------------------------------------------

  it('should reject with 401 when the signature header is malformed', () => {
    const ctx = makeCtx(
      { [WEBHOOK_SIGNATURE_HEADER]: 'not-a-valid-header' },
      { event: 'wallet.created' },
    );

    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    try {
      guard.canActivate(ctx);
      fail('expected canActivate to throw');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    }
  });

  // ---------------------------------------------------------------------------
  // Failure path — tampered payload (body changed after signing)
  // ---------------------------------------------------------------------------

  it('should reject with 401 when the body was tampered with after signing', () => {
    const originalBody = { event: 'wallet.created', amount: 100 };
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(originalBody, ts);

    const tamperedBody = { event: 'wallet.created', amount: 999999 };
    const ctx = makeCtx({ [WEBHOOK_SIGNATURE_HEADER]: header }, tamperedBody);

    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    try {
      guard.canActivate(ctx);
      fail('expected canActivate to throw');
    } catch (e) {
      const err = e as HttpException;
      expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect(err.getResponse()).toEqual({
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid webhook signature',
        error: 'Unauthorized',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Failure path — signature signed with the wrong secret
  // ---------------------------------------------------------------------------

  it('should reject with 401 when signed with an incorrect secret', () => {
    const body = { event: 'wallet.created' };
    const ts = Math.floor(Date.now() / 1000);
    const payloadString = JSON.stringify(body);
    const wrongSignature = signer.signPayload(
      payloadString,
      'wrong-secret',
      ts,
    );
    const header = signer.formatSignatureHeader(ts, wrongSignature);

    const ctx = makeCtx({ [WEBHOOK_SIGNATURE_HEADER]: header }, body);

    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
  });

  // ---------------------------------------------------------------------------
  // Failure path — expired / stale timestamp (replay protection)
  // ---------------------------------------------------------------------------

  it('should reject with 401 when the signature timestamp is too old', () => {
    const body = { event: 'wallet.created' };
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    const header = sign(body, staleTs);

    const ctx = makeCtx({ [WEBHOOK_SIGNATURE_HEADER]: header }, body);

    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    try {
      guard.canActivate(ctx);
      fail('expected canActivate to throw');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(HttpStatus.UNAUTHORIZED);
    }
  });

  // ---------------------------------------------------------------------------
  // Consistent error shape across every failure reason
  // ---------------------------------------------------------------------------

  it('should return the same error response shape for every rejection reason', () => {
    const body = { event: 'wallet.created' };
    const ts = Math.floor(Date.now() / 1000);

    const scenarios: Array<{
      headers: Record<string, string | string[] | undefined>;
      body: unknown;
    }> = [
      { headers: {}, body }, // missing header
      { headers: { [WEBHOOK_SIGNATURE_HEADER]: 'garbage' }, body }, // malformed
      { headers: { [WEBHOOK_SIGNATURE_HEADER]: sign(body, ts) }, body: { event: 'tampered' } }, // tampered
    ];

    const responses = scenarios.map((s) => {
      const ctx = makeCtx(s.headers, s.body);
      try {
        guard.canActivate(ctx);
        return undefined;
      } catch (e) {
        return (e as HttpException).getResponse();
      }
    });

    expect(responses).toEqual([
      {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid webhook signature',
        error: 'Unauthorized',
      },
      {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid webhook signature',
        error: 'Unauthorized',
      },
      {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: 'Invalid webhook signature',
        error: 'Unauthorized',
      },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Fail closed when the inbound secret is not configured
  // ---------------------------------------------------------------------------

  it('should fail closed with 500 when WEBHOOK_INBOUND_SECRET is not configured', () => {
    configService.get.mockReturnValue(undefined);
    const body = { event: 'wallet.created' };
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(body, ts);

    const ctx = makeCtx({ [WEBHOOK_SIGNATURE_HEADER]: header }, body);

    expect(() => guard.canActivate(ctx)).toThrow(HttpException);
    try {
      guard.canActivate(ctx);
      fail('expected canActivate to throw');
    } catch (e) {
      expect((e as HttpException).getStatus()).toBe(
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Header value provided as an array (some proxies duplicate headers)
  // ---------------------------------------------------------------------------

  it('should use the first value when the signature header is duplicated as an array', () => {
    const body = { event: 'wallet.created' };
    const ts = Math.floor(Date.now() / 1000);
    const header = sign(body, ts);

    const ctx = makeCtx({ [WEBHOOK_SIGNATURE_HEADER]: [header, header] }, body);

    expect(guard.canActivate(ctx)).toBe(true);
  });
});
