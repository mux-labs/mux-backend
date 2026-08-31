import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WebhookSecretService } from './webhook-secret.service';
import * as crypto from 'crypto';

const VALID_KEY = 'unit-test-webhook-signing-key-min-32-chars!!';

function makeConfigService(getImpl: (key: string, def?: any) => any) {
  return { get: jest.fn(getImpl) };
}

describe('WebhookSecretService', () => {
  let service: WebhookSecretService;

  describe('configuration (fail closed)', () => {
    it('throws when WEBHOOK_SIGNING_KEY is missing', () => {
      const configService = makeConfigService(() => undefined);
      expect(() => new WebhookSecretService(configService as any)).toThrow(
        /WEBHOOK_SIGNING_KEY/,
      );
    });

    it('throws when WEBHOOK_SIGNING_KEY is empty/whitespace', () => {
      const configService = makeConfigService(() => '   ');
      expect(() => new WebhookSecretService(configService as any)).toThrow(
        /WEBHOOK_SIGNING_KEY/,
      );
    });

    it('throws when WEBHOOK_SIGNING_KEY is shorter than 32 characters', () => {
      const configService = makeConfigService(() => 'too-short');
      expect(() => new WebhookSecretService(configService as any)).toThrow(
        /at least 32 characters/,
      );
    });

    it('throws when WEBHOOK_SIGNING_KEY is the placeholder value', () => {
      const configService = makeConfigService(
        () => 'dev-only-insecure-webhook-signing-key-min-32-chars',
      );
      expect(() => new WebhookSecretService(configService as any)).toThrow(
        /placeholder/,
      );
    });

    it('initializes with a valid 32+ char key', () => {
      const configService = makeConfigService(() => VALID_KEY);
      expect(
        () => new WebhookSecretService(configService as any),
      ).not.toThrow();
    });
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookSecretService,
        { provide: ConfigService, useValue: makeConfigService(() => VALID_KEY) },
      ],
    }).compile();

    service = module.get<WebhookSecretService>(WebhookSecretService);
  });

  describe('deriveSecret', () => {
    it('returns a secret in whsec_ format', () => {
      const secret = service.deriveSecret('endpoint-1', 1);
      expect(secret).toMatch(/^whsec_/);
    });

    it('is deterministic for the same endpoint id and version', () => {
      expect(service.deriveSecret('endpoint-1', 1)).toBe(
        service.deriveSecret('endpoint-1', 1),
      );
    });

    it('changes when the version changes', () => {
      expect(service.deriveSecret('endpoint-1', 1)).not.toBe(
        service.deriveSecret('endpoint-1', 2),
      );
    });

    it('changes when the endpoint id changes', () => {
      expect(service.deriveSecret('endpoint-1', 1)).not.toBe(
        service.deriveSecret('endpoint-2', 1),
      );
    });

    it('produces a different secret for a different master key', () => {
      const other = new WebhookSecretService(
        makeConfigService(
          () => 'a-different-webhook-signing-key-min-32-chars',
        ) as any,
      );
      expect(other.deriveSecret('endpoint-1', 1)).not.toBe(
        service.deriveSecret('endpoint-1', 1),
      );
    });
  });

  describe('hashSecret', () => {
    it('returns a 64-char SHA-256 hex digest', () => {
      const hash = service.hashSecret(service.deriveSecret('endpoint-1', 1));
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('matches crypto sha256 of the secret', () => {
      const secret = service.deriveSecret('endpoint-1', 1);
      expect(service.hashSecret(secret)).toBe(
        crypto.createHash('sha256').update(secret).digest('hex'),
      );
    });

    it('is one-way: the hash does not contain the secret', () => {
      const secret = service.deriveSecret('endpoint-1', 1);
      expect(service.hashSecret(secret)).not.toContain('whsec_');
      expect(service.hashSecret(secret)).not.toContain(secret);
    });
  });
});
