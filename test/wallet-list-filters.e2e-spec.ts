import {
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { WalletsController } from '../src/wallets/wallets.controller';
import { WalletsService } from '../src/wallets/wallets.service';
import { WalletCreationOrchestrator } from '../src/wallets/wallet-creation-orchestrator.service';
import { ApiKeyService } from '../src/api-keys/api-key.service';
import { ApiKeyGuard } from '../src/api-keys/api-key.guard';
import { FeatureFlagService } from '../src/common/feature-flags/feature-flag.service';
import { FeatureFlagGuard } from '../src/common/feature-flags/feature-flag.guard';
import { RateLimitService } from '../src/rate-limit/rate-limit.service';
import { RateLimitGuard } from '../src/rate-limit/rate-limit.guard';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { DEFAULT_WALLET_LIST_LIMIT } from '../src/wallets/dto/list-wallets-query.dto';

/**
 * e2e for GET /v1/wallets — pagination and the network/status filters (#936).
 *
 * Mounts only the wallet controller (plus the guards it uses) so the test does
 * not pull in the full application module graph, and stubs the service so no
 * database is required. The real `ValidationPipe` and the real query DTO run,
 * which is the point: the filter and bounds are enforced at the HTTP boundary.
 */
describe('WalletsController list — pagination + network filter (e2e, #936)', () => {
  let app: INestApplication;
  let findAll: jest.Mock;

  const emptyPage = {
    data: [],
    total: 0,
    limit: DEFAULT_WALLET_LIST_LIMIT,
    offset: 0,
    hasMore: false,
  };

  const apiKeyStub = {
    validateApiKey: jest.fn((key: string) => {
      if (key !== 'mux_test_valid') {
        return Promise.reject(new UnauthorizedException('Invalid API key'));
      }
      return Promise.resolve({
        apiKey: { id: 'api-key-id', network: undefined },
        project: { id: 'proj-id', name: 'proj-name', rateLimitRpm: 60 },
        developer: { id: 'dev-id', email: 'dev@example.com' },
      } as never);
    }),
    recordUsage: jest.fn(),
  };

  const flagStub = { isEnabled: jest.fn(() => true) };
  const rateLimitStub = {
    checkRateLimit: jest.fn(() =>
      Promise.resolve({
        allowed: true,
        remaining: 100,
        resetTime: new Date(),
        limit: 100,
      }),
    ),
  };

  beforeEach(async () => {
    findAll = jest.fn(() => Promise.resolve(emptyPage));

    const moduleRef = await Test.createTestingModule({
      controllers: [WalletsController],
      providers: [
        FeatureFlagGuard,
        ApiKeyGuard,
        RateLimitGuard,
        { provide: FeatureFlagService, useValue: flagStub },
        { provide: ApiKeyService, useValue: apiKeyStub },
        { provide: RateLimitService, useValue: rateLimitStub },
        { provide: WalletsService, useValue: { findAll } },
        {
          provide: WalletCreationOrchestrator,
          useValue: { createWallet: jest.fn() },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalGuards(
      new ApiKeyGuard(apiKeyStub as never, reflector),
      new FeatureFlagGuard(flagStub as never, reflector),
      new RateLimitGuard(rateLimitStub as never, reflector),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const list = (qs = '') =>
    request(app.getHttpServer())
      .get(`/v1/wallets${qs}`)
      .set('Authorization', 'Bearer mux_test_valid');

  describe('pagination', () => {
    it('returns the paginated envelope with server defaults', async () => {
      const res = await list().expect(200);

      expect(res.body).toEqual(emptyPage);
      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: DEFAULT_WALLET_LIST_LIMIT,
          offset: 0,
        }),
      );
    });

    it('forwards limit and offset', async () => {
      await list('?limit=10&offset=20').expect(200);

      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 20 }),
      );
    });

    it('accepts the documented maximum limit', async () => {
      await list('?limit=100').expect(200);

      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('rejects a limit above the maximum', async () => {
      await list('?limit=1000').expect(400);

      expect(findAll).not.toHaveBeenCalled();
    });

    it('rejects a limit below 1', async () => {
      await list('?limit=0').expect(400);
    });

    it('rejects a negative offset', async () => {
      await list('?offset=-1').expect(400);
    });

    it('rejects a non-numeric limit', async () => {
      await list('?limit=all').expect(400);
    });
  });

  describe('network filter', () => {
    it('forwards a valid network to the service', async () => {
      await list('?network=MAINNET').expect(200);

      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ network: 'MAINNET' }),
      );
    });

    it('rejects an unknown network instead of widening results across networks', async () => {
      // The regression this closes: a bogus `network` used to reach the
      // database filter untouched, so a typo could silently return wallets
      // from both testnet and mainnet.
      await list('?network=NOT_A_NETWORK').expect(400);

      expect(findAll).not.toHaveBeenCalled();
    });

    it('rejects a lowercase network', async () => {
      await list('?network=testnet').expect(400);

      expect(findAll).not.toHaveBeenCalled();
    });
  });

  describe('status filter and deny-by-default', () => {
    it('forwards a valid status', async () => {
      await list('?status=ACTIVE').expect(200);

      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ACTIVE' }),
      );
    });

    it('rejects an unknown status', async () => {
      await list('?status=NOT_A_STATUS').expect(400);
    });

    it('rejects an unknown query parameter', async () => {
      await list('?isAdmin=true').expect(400);

      expect(findAll).not.toHaveBeenCalled();
    });

    it('only enables loadTestMode on the literal "true"', async () => {
      await list('?loadTestMode=1').expect(200);

      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ loadTestMode: false }),
      );
    });
  });

  describe('authz negatives', () => {
    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/v1/wallets').expect(401);

      expect(findAll).not.toHaveBeenCalled();
    });

    it('rejects a revoked API key', async () => {
      await request(app.getHttpServer())
        .get('/v1/wallets')
        .set('Authorization', 'Bearer mux_test_revoked')
        .expect(401);

      expect(findAll).not.toHaveBeenCalled();
    });
  });
});
