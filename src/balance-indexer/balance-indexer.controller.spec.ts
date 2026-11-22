import { Test, TestingModule } from '@nestjs/testing';
import { BalanceIndexerController } from './balance-indexer.controller';
import { BalanceIndexerService } from './balance-indexer.service';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { AuthenticatedRequest } from '../auth/authenticated-request';

describe('BalanceIndexerController', () => {
  let controller: BalanceIndexerController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [BalanceIndexerController],
      providers: [
        {
          provide: BalanceIndexerService,
          useValue: {},
        },
      ],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<BalanceIndexerController>(BalanceIndexerController);
  });

  describe('actorFrom', () => {
    const developerUserId = 'user-owner-123';
    const developerId = 'developer-456';
    const apiKeyId = 'api-key-789';

    const buildRequest = (overrides: Record<string, unknown> = {}): AuthenticatedRequest =>
      ({
        apiKey: {
          id: apiKeyId,
          developer: {
            id: developerId,
            userId: developerUserId,
          },
        },
        body: {},
        query: {},
        ...overrides,
      } as unknown as AuthenticatedRequest);

    it('builds the actor subject from the authenticated key developer owning user', () => {
      const request = buildRequest();

      const actor = controller.actorFrom(request);

      expect(actor).toBeDefined();
      expect(actor.subject).toBe(developerUserId);
    });

    it('ignores ownership asserted in the request body', () => {
      const request = buildRequest({
        body: { userId: 'attacker-user', subject: 'attacker-user', ownerId: 'attacker-user' },
      });

      const actor = controller.actorFrom(request);

      expect(actor.subject).toBe(developerUserId);
      expect(actor.subject).not.toBe('attacker-user');
    });

    it('ignores ownership asserted in the request query', () => {
      const request = buildRequest({
        query: { userId: 'attacker-user', subject: 'attacker-user', ownerId: 'attacker-user' },
      });

      const actor = controller.actorFrom(request);

      expect(actor.subject).toBe(developerUserId);
      expect(actor.subject).not.toBe('attacker-user');
    });

    it('throws when the request has no authenticated key context', () => {
      const request = buildRequest({ apiKey: undefined });

      expect(() => controller.actorFrom(request)).toThrow();
    });

    it('throws when the authenticated key has no owning developer user', () => {
      const request = buildRequest({
        apiKey: { id: apiKeyId, developer: { id: developerId } },
      });

      expect(() => controller.actorFrom(request)).toThrow();
    });
  });
});
