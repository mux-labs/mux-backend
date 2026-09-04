import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Controller, Get } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import request from 'supertest';
import { ResponseSanitizerInterceptor } from '../src/common/interceptors/response-sanitizer.interceptor';

/**
 * #695 — ResponseSanitizerInterceptor must apply globally, so routes that do
 * NOT opt in (like the wallet routes) still have sensitive fields redacted.
 *
 * This controller intentionally has no `@UseInterceptors` decorator; the only
 * thing redacting its response is the global APP_INTERCEPTOR registration —
 * the same wiring added to AppModule.
 */
@Controller('leaky')
class LeakyController {
  @Get('wallet')
  wallet() {
    return {
      id: 'wallet-1',
      publicKey: 'GABC',
      privateKey: 'S-super-secret',
      encryptedSecret: '{"encryptedData":"deadbeef","iv":"x","tag":"y"}',
      nested: { encrypted_secret: 'also-secret', ok: 'visible' },
    };
  }

  @Get('list')
  list() {
    return [{ privateKey: 'S-1' }, { privateKey: 'S-2' }];
  }
}

describe('ResponseSanitizerInterceptor applied globally (e2e) [#695]', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [LeakyController],
      providers: [
        { provide: APP_INTERCEPTOR, useClass: ResponseSanitizerInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('redacts sensitive fields on a controller that never opted in', async () => {
    const res = await request(app.getHttpServer()).get('/leaky/wallet');

    expect(res.status).toBe(200);
    expect(res.body.privateKey).toBe('[REDACTED]');
    expect(res.body.encryptedSecret).toBe('[REDACTED]');
    expect(res.body.nested.encrypted_secret).toBe('[REDACTED]');
    expect(res.body.nested.ok).toBe('visible');
    expect(res.body.publicKey).toBe('GABC');
  });

  it('redacts sensitive fields inside array responses', async () => {
    const res = await request(app.getHttpServer()).get('/leaky/list');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { privateKey: '[REDACTED]' },
      { privateKey: '[REDACTED]' },
    ]);
  });
});
