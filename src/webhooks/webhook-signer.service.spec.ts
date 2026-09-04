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

    it('should reject a tampered payload even with a structurally valid signature', () => {
      const secret = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);
      const originalPayload = JSON.stringify({ amount: 100 });
      const tamperedPayload = JSON.stringify({ amount: 999999 });

      // Signature was computed over the original payload...
      const signature = service.signPayload(
        originalPayload,
        secret,
        timestamp,
      );

      // ...but the attacker sends a different payload with that signature.
      const isValid = service.verifySignature(
        tamperedPayload,
        signature,
        secret,
        timestamp,
      );

      expect(isValid).toBe(false);
    });

    it('should reject when signed with the wrong secret', () => {
      const payload = JSON.stringify({ test: 'data' });
      const timestamp = Math.floor(Date.now() / 1000);

      const signature = service.signPayload(
        payload,
        'correct-secret',
        timestamp,
      );
      const isValid = service.verifySignature(
        payload,
        signature,
        'wrong-secret',
        timestamp,
      );

      expect(isValid).toBe(false);
    });

    it('should reject signatures of a different length without throwing', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);

      expect(() =>
        service.verifySignature(payload, 'short', secret, timestamp),
      ).not.toThrow();
      expect(
        service.verifySignature(payload, 'short', secret, timestamp),
      ).toBe(false);
    });

    it('should reject empty-string signatures', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000);

      expect(
        service.verifySignature(payload, '', secret, timestamp),
      ).toBe(false);
    });

    it('should reject timestamps too far in the future (clock skew abuse)', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const futureTimestamp = Math.floor(Date.now() / 1000) + 600; // 10 min ahead

      const signature = service.signPayload(payload, secret, futureTimestamp);
      const isValid = service.verifySignature(
        payload,
        signature,
        secret,
        futureTimestamp,
        300,
      );

      expect(isValid).toBe(false);
    });

    it('should accept a signature at the edge of the tolerance window', () => {
      const payload = JSON.stringify({ test: 'data' });
      const secret = 'test-secret';
      const timestamp = Math.floor(Date.now() / 1000) - 299; // just inside 300s

      const signature = service.signPayload(payload, secret, timestamp);
      const isValid = service.verifySignature(
        payload,
        signature,
        secret,
        timestamp,
        300,
      );

      expect(isValid).toBe(true);
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

    it('should return null when the header is an empty string', () => {
      const result = service.parseSignatureHeader('');

      expect(result).toBeNull();
    });

    it('should return null when the timestamp component is missing', () => {
      const header = 'v1=abcdef123456';

      const result = service.parseSignatureHeader(header);

      expect(result).toBeNull();
    });

    it('should return null when the signature component is missing', () => {
      const header = 't=1234567890';

      const result = service.parseSignatureHeader(header);

      expect(result).toBeNull();
    });
  });

  describe('end-to-end sign + verify', () => {
    it('should accept a signature generated via generateSignatureHeaders and formatSignatureHeader', () => {
      const secret = 'test-secret';
      const payload = { walletId: 'wallet-1', amount: 42 };

      const { timestamp, signature } = service.generateSignatureHeaders(
        payload,
        secret,
      );
      const header = service.formatSignatureHeader(timestamp, signature);
      const parsed = service.parseSignatureHeader(header);

      expect(parsed).not.toBeNull();
      const isValid = service.verifySignature(
        JSON.stringify(payload),
        parsed!.signature,
        secret,
        parsed!.timestamp,
      );

      expect(isValid).toBe(true);
    });

    it('should reject when the receiver uses a different secret than the sender', () => {
      const payload = { walletId: 'wallet-1', amount: 42 };

      const { timestamp, signature } = service.generateSignatureHeaders(
        payload,
        'sender-secret',
      );

      const isValid = service.verifySignature(
        JSON.stringify(payload),
        signature,
        'receiver-secret',
        timestamp,
      );

      expect(isValid).toBe(false);
    });
  });
});
