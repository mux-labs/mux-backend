import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TransactionExportService } from './transaction-export.service';
import { PrismaService } from '../prisma/prisma.service';

/** Minimal transaction fixture for tests */
const TX_FIXTURE = {
  id: 'tx-1',
  amount: '10.5',
  assetType: 'NATIVE',
  assetCode: null,
  assetIssuer: null,
  senderWalletId: 'wallet-1',
  receiverWalletId: 'wallet-2',
  memo: 'Test payment',
  status: 'CONFIRMED',
  stellarHash: 'hash123',
  stellarLedger: 48000,
  stellarFee: '100',
  statusChangedAt: new Date('2026-07-01T00:00:00.000Z'),
  statusReason: null,
  submittedAt: new Date('2026-07-01T00:00:00.000Z'),
  confirmedAt: new Date('2026-07-01T00:00:01.000Z'),
  failedAt: null,
  idempotencyKey: null,
  createdAt: new Date('2026-07-01T00:00:00.000Z'),
  updatedAt: new Date('2026-07-01T00:00:01.000Z'),
};

const JOB_FIXTURE = {
  id: 'job-1',
  projectId: 'proj-1',
  requestedBy: 'apikey-1',
  format: 'CSV',
  filters: null,
  status: 'PENDING',
  rowCount: 0,
  downloadUrl: null,
  expiresAt: null,
  errorMessage: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date('2026-07-27T05:00:00.000Z'),
  updatedAt: new Date('2026-07-27T05:00:00.000Z'),
};

describe('TransactionExportService', () => {
  let service: TransactionExportService;
  let mockPrisma: {
    transactionExportJob: {
      create: jest.Mock;
      update: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    transaction: {
      findMany: jest.Mock;
    };
  };

  beforeEach(async () => {
    mockPrisma = {
      transactionExportJob: {
        create: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      transaction: {
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionExportService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TransactionExportService>(TransactionExportService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // createExportJob — success path
  // ---------------------------------------------------------------------------

  describe('createExportJob', () => {
    it('should create a PENDING job and return its summary immediately', async () => {
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce({
        ...JOB_FIXTURE,
        status: 'PENDING',
      });
      // The background runExport will call update and transaction.findMany
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transactionExportJob.update.mockResolvedValue({});

      const result = await service.createExportJob({
        projectId: 'proj-1',
        requestedBy: 'apikey-1',
        format: 'CSV',
      });

      expect(result.id).toBe('job-1');
      expect(result.status).toBe('PENDING');
      expect(result.format).toBe('CSV');
      expect(mockPrisma.transactionExportJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId: 'proj-1',
            format: 'CSV',
            status: 'PENDING',
          }),
        }),
      );
    });

    it('should default to CSV format when none specified', async () => {
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce({
        ...JOB_FIXTURE,
        format: 'CSV',
      });
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transactionExportJob.update.mockResolvedValue({});

      await service.createExportJob({ projectId: 'proj-1' });

      expect(mockPrisma.transactionExportJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ format: 'CSV' }),
        }),
      );
    });

    it('should accept JSON format', async () => {
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce({
        ...JOB_FIXTURE,
        format: 'JSON',
      });
      mockPrisma.transaction.findMany.mockResolvedValue([]);
      mockPrisma.transactionExportJob.update.mockResolvedValue({});

      const result = await service.createExportJob({
        projectId: 'proj-1',
        format: 'JSON',
      });

      expect(result.format).toBe('JSON');
    });

    it('should throw BadRequestException for an unsupported format', async () => {
      await expect(
        service.createExportJob({
          projectId: 'proj-1',
          format: 'XLSX' as any,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // getExportJob — success and failure paths
  // ---------------------------------------------------------------------------

  describe('getExportJob', () => {
    it('should return the job summary when found', async () => {
      mockPrisma.transactionExportJob.findFirst.mockResolvedValueOnce({
        ...JOB_FIXTURE,
        status: 'COMPLETED',
        rowCount: 42,
        downloadUrl: 'data:text/csv;base64,aGVsbG8=',
        completedAt: new Date(),
      });

      const result = await service.getExportJob('job-1', 'proj-1');

      expect(result.id).toBe('job-1');
      expect(result.status).toBe('COMPLETED');
      expect(result.rowCount).toBe(42);
      expect(result.downloadUrl).toMatch(/^data:/);
    });

    it('should scope query to projectId to enforce tenant isolation', async () => {
      mockPrisma.transactionExportJob.findFirst.mockResolvedValueOnce(null);

      await expect(service.getExportJob('job-1', 'proj-other')).rejects.toThrow(
        NotFoundException,
      );

      expect(mockPrisma.transactionExportJob.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ projectId: 'proj-other' }),
        }),
      );
    });

    it('should throw NotFoundException for an unknown job ID', async () => {
      mockPrisma.transactionExportJob.findFirst.mockResolvedValueOnce(null);

      await expect(service.getExportJob('nonexistent', 'proj-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // listExportJobs
  // ---------------------------------------------------------------------------

  describe('listExportJobs', () => {
    it('should return paginated jobs for the project', async () => {
      mockPrisma.transactionExportJob.findMany.mockResolvedValueOnce([JOB_FIXTURE]);
      mockPrisma.transactionExportJob.count.mockResolvedValueOnce(1);

      const result = await service.listExportJobs('proj-1', 20, 0);

      expect(result.jobs).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockPrisma.transactionExportJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectId: 'proj-1' },
          take: 20,
          skip: 0,
        }),
      );
    });

    it('should return empty list when project has no jobs', async () => {
      mockPrisma.transactionExportJob.findMany.mockResolvedValueOnce([]);
      mockPrisma.transactionExportJob.count.mockResolvedValueOnce(0);

      const result = await service.listExportJobs('proj-new');

      expect(result.jobs).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Background runExport — success path via integration through createExportJob
  // ---------------------------------------------------------------------------

  describe('background export processing', () => {
    it('should transition job to COMPLETED with rowCount and downloadUrl on success', async () => {
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce(JOB_FIXTURE);
      mockPrisma.transactionExportJob.update.mockResolvedValue({});
      mockPrisma.transaction.findMany.mockResolvedValue([TX_FIXTURE]);

      await service.createExportJob({ projectId: 'proj-1', format: 'CSV' });

      // Wait for the async export to run (it's fire-and-forget, use a tick)
      await new Promise((resolve) => setImmediate(resolve));

      // Should have called update to RUNNING then COMPLETED
      const updateCalls = mockPrisma.transactionExportJob.update.mock.calls;
      expect(updateCalls.some((c) => c[0].data.status === 'RUNNING')).toBe(true);
      expect(updateCalls.some((c) => c[0].data.status === 'COMPLETED')).toBe(true);

      const completedCall = updateCalls.find((c) => c[0].data.status === 'COMPLETED');
      expect(completedCall![0].data.rowCount).toBe(1);
      expect(completedCall![0].data.downloadUrl).toMatch(/^data:/);
    });

    it('should transition job to FAILED when the query throws', async () => {
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce(JOB_FIXTURE);
      mockPrisma.transactionExportJob.update.mockResolvedValue({});
      mockPrisma.transaction.findMany.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      await service.createExportJob({ projectId: 'proj-1', format: 'CSV' });

      await new Promise((resolve) => setImmediate(resolve));

      const updateCalls = mockPrisma.transactionExportJob.update.mock.calls;
      const failedCall = updateCalls.find((c) => c[0].data.status === 'FAILED');
      expect(failedCall).toBeDefined();
      expect(failedCall![0].data.errorMessage).toContain('DB connection lost');
    });

    it('should produce valid CSV with headers and one data row', async () => {
      let capturedDownloadUrl = '';
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce(JOB_FIXTURE);
      mockPrisma.transactionExportJob.update.mockImplementation((args) => {
        if (args.data.downloadUrl) capturedDownloadUrl = args.data.downloadUrl;
        return Promise.resolve({});
      });
      mockPrisma.transaction.findMany.mockResolvedValue([TX_FIXTURE]);

      await service.createExportJob({ projectId: 'proj-1', format: 'CSV' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(capturedDownloadUrl).toMatch(/^data:text\/csv;base64,/);
      const csvContent = Buffer.from(
        capturedDownloadUrl.replace('data:text/csv;base64,', ''),
        'base64',
      ).toString('utf-8');

      expect(csvContent).toContain('id,amount,assetType');
      expect(csvContent).toContain('tx-1');
      expect(csvContent).toContain('10.5');
    });

    it('should produce valid JSON export', async () => {
      let capturedDownloadUrl = '';
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce({
        ...JOB_FIXTURE,
        format: 'JSON',
      });
      mockPrisma.transactionExportJob.update.mockImplementation((args) => {
        if (args.data.downloadUrl) capturedDownloadUrl = args.data.downloadUrl;
        return Promise.resolve({});
      });
      mockPrisma.transaction.findMany.mockResolvedValue([TX_FIXTURE]);

      await service.createExportJob({ projectId: 'proj-1', format: 'JSON' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(capturedDownloadUrl).toMatch(/^data:application\/json;base64,/);
      const json = JSON.parse(
        Buffer.from(
          capturedDownloadUrl.replace('data:application/json;base64,', ''),
          'base64',
        ).toString('utf-8'),
      );
      expect(Array.isArray(json)).toBe(true);
      expect(json[0].id).toBe('tx-1');
    });

    it('should handle empty result set gracefully', async () => {
      mockPrisma.transactionExportJob.create.mockResolvedValueOnce(JOB_FIXTURE);
      mockPrisma.transactionExportJob.update.mockResolvedValue({});
      mockPrisma.transaction.findMany.mockResolvedValue([]);

      await service.createExportJob({ projectId: 'proj-1', format: 'CSV' });
      await new Promise((resolve) => setImmediate(resolve));

      const updateCalls = mockPrisma.transactionExportJob.update.mock.calls;
      const completedCall = updateCalls.find((c) => c[0].data.status === 'COMPLETED');
      expect(completedCall).toBeDefined();
      expect(completedCall![0].data.rowCount).toBe(0);
    });
  });
});
