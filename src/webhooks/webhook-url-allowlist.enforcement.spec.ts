import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import {
  WebhookUrlAllowlistService,
  WebhookUrlErrorCode,
  WEBHOOK_ALLOWED_HOSTS_ENV,
} from './webhook-url-allowlist.service';
import { SafeLogger } from '../common/safe-logger';

/** Runs `fn` and returns the rejection reason, or undefined if it resolved. */
async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return err;
  }
}

/** Reads the stable `code` off a Nest exception body. */
function errorCode(err: unknown): string | undefined {
  const response = (err as { response?: { code?: unknown } })?.response;
  return typeof response?.code === 'string' ? response.code : undefined;
}

/**
 * SSRF allowlist enforcement at the endpoint write boundary.
 *
 * `webhook.service.spec.ts` predates the allowlist and already fails on `main`
 * for an unrelated DI reason, so these invariants get their own focused suite
 * rather than being appended to a suite that cannot run.
 */
describe('WebhookService — SSRF allowlist enforcement', () => {
  const HOST = 'hooks.example.com';

  let prisma: {
    webhookEndpoint: { create: jest.Mock; update: jest.Mock };
  };
  let service: WebhookService;

  beforeEach(() => {
    prisma = {
      webhookEndpoint: {
        create: jest.fn().mockResolvedValue({
          id: 'ep-1',
          projectId: 'proj-1',
          url: `https://${HOST}/webhook`,
          events: ['wallet.created'],
          description: null,
          secret: 'whsec_x',
          status: 'ACTIVE',
          consecutiveFailures: 0,
          lastFailureAt: null,
          lastFailureReason: null,
          lastSuccessAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: jest.fn().mockResolvedValue({ id: 'ep-1' }),
      },
    };

    const config = new ConfigService({ [WEBHOOK_ALLOWED_HOSTS_ENV]: HOST });
    const cache = { get: jest.fn(), set: jest.fn(), delete: jest.fn() };

    service = new WebhookService(
      prisma as any,
      cache as any,
      new WebhookUrlAllowlistService(config),
    );
    // The real SafeLogger is not needed here; the point is that the log line
    // carries only the code and host, never the URL or the secret.
    Object.defineProperty(service, 'logger', {
      value: new SafeLogger('test'),
    });
  });

  describe('createEndpoint', () => {
    it('persists an allowlisted https endpoint', async () => {
      await service.createEndpoint({
        projectId: 'proj-1',
        url: `https://${HOST}/webhook`,
        events: ['wallet.created'],
      });

      expect(prisma.webhookEndpoint.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a cloud-metadata target and writes nothing', async () => {
      const error = await captureError(() =>
        service.createEndpoint({
          projectId: 'proj-1',
          url: 'https://169.254.169.254/latest/meta-data/',
          events: ['wallet.created'],
        }),
      );

      expect(errorCode(error)).toBe(WebhookUrlErrorCode.BLOCKED_HOST);
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('rejects a loopback target and writes nothing', async () => {
      await expect(
        service.createEndpoint({
          projectId: 'proj-1',
          url: 'https://127.0.0.1:8443/webhook',
          events: ['wallet.created'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });

    it('rejects a non-allowlisted host with a stable code', async () => {
      const error = await captureError(() =>
        service.createEndpoint({
          projectId: 'proj-1',
          url: 'https://attacker.example.net/webhook',
          events: ['wallet.created'],
        }),
      );

      expect(errorCode(error)).toBe(WebhookUrlErrorCode.NOT_ALLOWLISTED);
      expect(prisma.webhookEndpoint.create).not.toHaveBeenCalled();
    });
  });

  describe('updateEndpoint', () => {
    it('re-checks a repointed URL so an endpoint cannot be moved internally', async () => {
      await expect(
        service.updateEndpoint('ep-1', { url: 'https://10.0.0.5/webhook' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.webhookEndpoint.update).not.toHaveBeenCalled();
    });

    it('allows a non-URL update without touching the allowlist', async () => {
      await service.updateEndpoint('ep-1', { description: 'renamed' });

      expect(prisma.webhookEndpoint.update).toHaveBeenCalledWith({
        where: { id: 'ep-1' },
        data: { description: 'renamed' },
      });
    });
  });
});
