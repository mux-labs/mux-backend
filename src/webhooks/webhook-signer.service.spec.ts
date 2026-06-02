import { Test, TestingModule } from '@nestjs/testing';
import { WebhookSignerService } from './webhook-signer.service';

describe('WebhookSignerService', () => {
  let service: WebhookSignerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookSignerService],
    }).compile();

    service = module.get<WebhookSignerService>(WebhookSignerService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('signPayload', () => {
    it('should generate consistent signature for same input', () => {
      const payload = 'test-payload';
      const secret = 'test-secret';
      const timestamp = 1234567890;

      const sig1 = service.signPayload(payload, secret, timestamp);
      const sig2 = service.signPayload(payload, secret, timestamp);

      expect(sig1).toBe(sig2);
    });

    it('should generate different signatures for different payloads', () => {
      const secret = 'test-secret';
      const timestamp = 1234567890;

      const sig1 = service.signPayload('payload-1', secret, timestamp);
      const sig2 = service.signPayload('payload-2', secret, timestamp);

      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different timestamps', () => {
      const payload = 'test-payload';
      const secret = 'test-secret';

      const sig1 = service.signPayload(payload, secret, 1234567890);
      const sig2 = service.signPayload(payload, secret, 1234567891);

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('verifySignature', () => {
    it('should verify valid signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = service.signPayload(payload, secret, timestamp);
      const isValid = service.verifySignature(
        payload,
        signature,
        secret,
        timestamp,
      );

      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);

      const isValid = service.verifySignature(
        payload,
        'invalid-signature',
        secret,
        timestamp,
      );

      expect(isValid).toBe(false);
    });

    it('should reject old timestamps (replay attack prevention)', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago

      const signature = service.signPayload(payload, secret, oldTimestamp);
      const isValid = service.verifySignature(
        payload,
        signature,
        secret,
        oldTimestamp,
        300,
      ); // 5 min tolerance

      expect(isValid).toBe(false);
    });
  });

  describe('formatSignatureHeader', () => {
    it('should format signature in correct format', () => {
      const timestamp = 1234567890;
      const signature = 'abcdef123456';

      const header = service.formatSignatureHeader(timestamp, signature);

      expect(header).toBe('t=1234567890,v1=abcdef123456');
    });
  });

  describe('parseSignatureHeader', () => {
    it('should parse valid signature header', () => {
      const header = 't=1234567890,v1=abcdef123456';

      const result = service.parseSignatureHeader(header);

      expect(result).toEqual({
        timestamp: 1234567890,
        signature: 'abcdef123456',
      });
    });

    it('should return null for invalid header', () => {
      const header = 'invalid-header';

      const result = service.parseSignatureHeader(header);

      expect(result).toBeNull();
    });
  });
});
