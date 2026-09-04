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
});
