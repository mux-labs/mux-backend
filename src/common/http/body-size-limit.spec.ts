import express from 'express';
import request from 'supertest';
import { configureBodySizeLimit } from './body-size-limit';

describe('configureBodySizeLimit', () => {
  function createApp(limitBytes: number) {
    const app = express();
    configureBodySizeLimit(app, limitBytes);
    app.post('/public', (req, res) => res.status(201).json(req.body));
    return app;
  }

  it('accepts a JSON request below the configured limit', async () => {
    await request(createApp(128))
      .post('/public')
      .send({ value: 'small' })
      .expect(201, { value: 'small' });
  });

  it('returns a consistent 413 response when JSON exceeds the limit', async () => {
    await request(createApp(32))
      .post('/public')
      .send({ value: 'x'.repeat(64) })
      .expect(413, {
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Request body exceeds the maximum allowed size',
      });
  });

  // ── #788 README alignment ──────────────────────────────────────────────────

  it('#788 default body limit (100 KiB = 102400 bytes) accepts a 100 KiB payload', async () => {
    const defaultLimitBytes = 102_400; // matches validateEnv default
    const app = createApp(defaultLimitBytes);
    // Build a payload that is just under 100 KiB
    const payload = { data: 'x'.repeat(defaultLimitBytes - 20) };
    await request(app)
      .post('/public')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload))
      .expect(201);
  });

  it('#788 default body limit rejects a payload just over 100 KiB with structured 413', async () => {
    const defaultLimitBytes = 102_400;
    const app = createApp(defaultLimitBytes);
    // Build a payload that exceeds the default
    const payload = { data: 'x'.repeat(defaultLimitBytes + 500) };
    await request(app)
      .post('/public')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(payload))
      .expect(413)
      .expect((res) => {
        // #788: Matches the exact envelope documented in README
        expect(res.body.statusCode).toBe(413);
        expect(res.body.error).toBe('Payload Too Large');
        expect(res.body.message).toBe(
          'Request body exceeds the maximum allowed size',
        );
      });
  });

  it('#788 urlencoded request over limit also returns 413', async () => {
    const app = createApp(64);
    await request(app)
      .post('/public')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('data=' + 'x'.repeat(200))
      .expect(413, {
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Request body exceeds the maximum allowed size',
      });
  });
});
