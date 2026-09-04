/**
 * UsersService user-deletion integration suite.
 *
 * Exercises the full teardown path of `UsersService.remove()` end-to-end
 * without a live database, using a mocked Prisma client that mirrors the
 * transaction boundary the service runs inside.
 *
 * Security invariants covered:
 * - custody wallets transition to DISABLED (terminal) so keys can never sign
 * - API keys under the user's projects are REVOKED so they can no longer
 *   authenticate to the /v1 API
 * - only resources owned by the deleted user are touched
 * - the whole deletion is atomic (a failing step rolls everything back)
 * - logs never contain WALLET_ENCRYPTION_KEY, API key material, or seeds
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { MetricsService } from '../common/metrics/metrics.service';
import { PrismaClient } from '../generated/prisma/client';

const NOW = new Date('2026-08-31T00:00:00.000Z');

const makeUser = (o: Record<string, any> = {}) => ({
  id: 'user-abc',
  authId: 'auth-abc',
  email: 'u@example.com',
  displayName: 'Test User',
  status: 'ACTIVE',
  authProvider: 'GOOGLE',
  lastLoginAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...o,
});

const makeTx = () => ({
  user: { update: jest.fn() },
  wallet: { updateMany: jest.fn() },
  developer: { findMany: jest.fn(), updateMany: jest.fn() },
  project: { findMany: jest.fn(), updateMany: jest.fn() },
  apiKey: { updateMany: jest.fn() },
  webhookEndpoint: { updateMany: jest.fn() },
});

describe('UsersService user deletion (integration)', () => {
  let service: UsersService;
  let mockTx: ReturnType<typeof makeTx>;
  let mockPrisma: any;
  let metrics: { incrementCounter: jest.Mock; recordHistogram: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    mockTx = makeTx();
    mockPrisma = {
      user: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      legacyUser: { findUnique: jest.fn() },
      $transaction: jest.fn((cb: any) => cb(mockTx)),
    };
    metrics = {
      incrementCounter: jest.fn(),
      recordHistogram: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: MetricsService, useValue: metrics },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('remove()', () => {
    it('fully tears down every resource owned by the deleted user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockTx.wallet.updateMany.mockResolvedValue({ count: 2 });
      mockTx.developer.findMany.mockResolvedValue([{ id: 'dev-1' }]);
      mockTx.project.findMany.mockResolvedValue([{ id: 'proj-1' }]);
      mockTx.apiKey.updateMany.mockResolvedValue({ count: 2 });
      mockTx.webhookEndpoint.updateMany.mockResolvedValue({ count: 1 });
      mockTx.project.updateMany.mockResolvedValue({ count: 1 });
      mockTx.developer.updateMany.mockResolvedValue({ count: 1 });
      mockTx.user.update.mockResolvedValue(makeUser({ deletedAt: NOW }));

      const result = await service.remove('user-abc');

      expect(result).toMatchObject({ id: 'user-abc', deletedAt: NOW });
      expect(mockTx.wallet.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-abc',
          status: { notIn: ['DISABLED', 'COMPROMISED', 'ARCHIVED'] },
        },
        data: {
          status: 'DISABLED',
          statusReason: 'Owner user deleted',
          statusChangedAt: NOW,
        },
      });
      expect(mockTx.developer.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-abc', deletedAt: null },
        select: { id: true },
      });
      expect(mockTx.project.findMany).toHaveBeenCalledWith({
        where: { developerId: { in: ['dev-1'] }, deletedAt: null },
        select: { id: true },
      });
      expect(mockTx.apiKey.updateMany).toHaveBeenCalledWith({
        where: { projectId: { in: ['proj-1'] }, status: { not: 'REVOKED' } },
        data: {
          status: 'REVOKED',
          revokedAt: NOW,
          revokedReason: 'Owner user deleted',
        },
      });
      expect(mockTx.webhookEndpoint.updateMany).toHaveBeenCalledWith({
        where: { projectId: { in: ['proj-1'] }, status: { not: 'DISABLED' } },
        data: { status: 'DISABLED', deletedAt: NOW },
      });
      expect(mockTx.project.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['proj-1'] } },
        data: { deletedAt: NOW },
      });
      expect(mockTx.developer.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['dev-1'] } },
        data: { deletedAt: NOW },
      });
      expect(mockTx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-abc' },
        data: { deletedAt: NOW },
      });

      // Metrics recorded on success
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'users_deleted_total',
        { outcome: 'success' },
      );
      expect(metrics.recordHistogram).toHaveBeenCalledWith(
        'users_deletion_duration_seconds',
        expect.any(Number),
      );
    });

    it('marks wallets DISABLED (terminal) so custody keys can never sign again', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockTx.wallet.updateMany.mockResolvedValue({ count: 2 });
      mockTx.developer.findMany.mockResolvedValue([]);
      mockTx.user.update.mockResolvedValue(makeUser({ deletedAt: NOW }));

      await service.remove('user-abc');

      const call = mockTx.wallet.updateMany.mock.calls[0][0];
      expect(call.data.status).toBe('DISABLED');
      // DISABLED is a terminal wallet state — it cannot transition back to ACTIVE.
      expect(call.data.statusReason).toBe('Owner user deleted');
    });

    it('never touches resources owned by other users', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockTx.wallet.updateMany.mockResolvedValue({ count: 0 });
      mockTx.developer.findMany.mockResolvedValue([{ id: 'dev-1' }]);
      mockTx.project.findMany.mockResolvedValue([{ id: 'proj-1' }]);
      mockTx.apiKey.updateMany.mockResolvedValue({ count: 1 });
      mockTx.webhookEndpoint.updateMany.mockResolvedValue({ count: 0 });
      mockTx.project.updateMany.mockResolvedValue({ count: 1 });
      mockTx.developer.updateMany.mockResolvedValue({ count: 1 });
      mockTx.user.update.mockResolvedValue(makeUser({ deletedAt: NOW }));

      await service.remove('user-abc');

      // Teardown is scoped strictly to the deleted user's owned rows.
      expect(mockTx.developer.findMany).toHaveBeenCalledWith({
        where: { userId: 'user-abc', deletedAt: null },
        select: { id: true },
      });
      expect(mockTx.wallet.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-abc' }),
        }),
      );
    });

    it('throws ConflictException for an already-deleted user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(
        makeUser({ deletedAt: NOW }),
      );

      await expect(service.remove('user-abc')).rejects.toThrow(
        ConflictException,
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a missing user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.remove('ghost')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rolls back and propagates when any step of the transaction fails', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(makeUser());
      mockTx.wallet.updateMany.mockResolvedValue({ count: 1 });
      mockTx.developer.findMany.mockRejectedValue(new Error('db write error'));

      await expect(service.remove('user-abc')).rejects.toThrow(
        'db write error',
      );

      // Failure metric recorded; nothing after the failing step ran.
      expect(metrics.incrementCounter).toHaveBeenCalledWith(
        'users_deleted_total',
        { outcome: 'failure' },
      );
      expect(mockTx.user.update).not.toHaveBeenCalled();
    });

    it('does not log WALLET_ENCRYPTION_KEY, API keys, or seeds', async () => {
      const logSpy = jest.spyOn(Logger.prototype, 'log');
      const errorSpy = jest.spyOn(Logger.prototype, 'error');

      try {
        mockPrisma.user.findUnique.mockResolvedValue(makeUser());
        mockTx.wallet.updateMany.mockResolvedValue({ count: 1 });
        mockTx.developer.findMany.mockResolvedValue([{ id: 'dev-1' }]);
        mockTx.project.findMany.mockResolvedValue([{ id: 'proj-1' }]);
        mockTx.apiKey.updateMany.mockResolvedValue({ count: 1 });
        mockTx.webhookEndpoint.updateMany.mockResolvedValue({ count: 0 });
        mockTx.project.updateMany.mockResolvedValue({ count: 1 });
        mockTx.developer.updateMany.mockResolvedValue({ count: 1 });
        mockTx.user.update.mockResolvedValue(makeUser({ deletedAt: NOW }));

        await service.remove('user-abc');

        // Also exercise the failure log path so error output is covered.
        mockTx.developer.findMany.mockRejectedValueOnce(new Error('db error'));
        await service.remove('user-abc').catch(() => undefined);
      } finally {
        const allLogged = JSON.stringify([
          ...logSpy.mock.calls,
          ...errorSpy.mock.calls,
        ]);
        expect(allLogged).not.toContain('WALLET_ENCRYPTION_KEY');
        expect(allLogged).not.toContain('mux_live_');
        expect(allLogged).not.toContain('enc-secret');
        expect(allLogged).not.toContain('seed');

        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });
});
