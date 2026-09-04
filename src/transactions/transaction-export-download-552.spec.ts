/**
 * Unit tests for short-lived signed export download links (#552).
 *
 * Covers:
 *  - generateDownloadToken: produces a verifiable token
 *  - verifyDownloadToken: accepts a valid token
 *  - verifyDownloadToken: rejects a tampered token
 *  - verifyDownloadToken: rejects an expired token
 *  - verifyDownloadToken: rejects a malformed token
 *  - TransactionExportService.issueDownloadLink: success path
 *  - TransactionExportService.issueDownloadLink: rejects non-COMPLETED job
 *  - TransactionExportService.resolveDownload: returns correct content
 *  - TransactionExportService.resolveDownload: rejects mismatched jobId in token
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  TransactionExportService,
  generateDownloadToken,
  verifyDownloadToken,
} from './transaction-export.service';
import { PrismaService } from '../prisma/prisma.service';

// ── Token helpers ─────────────────────────────────────────────────────────────

describe('generateDownloadToken / verifyDownloadToken (#552)', () => {
  const JOB_ID = 'job-uuid-1';
  const PROJECT_ID = 'proj-uuid-1';
  const exportSigningSecret = 'a'.repeat(32);

  beforeEach(() => {
    process.env.EXPORT_SIGNING_SECRET = exportSigningSecret;
  });

  afterEach(() => {
    delete process.env.EXPORT_SIGNING_SECRET;
  });

  it('generates a token that round-trips through verify', () => {
    const { token } = generateDownloadToken(JOB_ID, PROJECT_ID);
    const payload = verifyDownloadToken(token);

    expect(payload.jobId).toBe(JOB_ID);
    expect(payload.projectId).toBe(PROJECT_ID);
    expect(new Date(payload.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('generated token expires in approximately the specified TTL', () => {
    const ttlMs = 10 * 60 * 1000; // 10 minutes
    const before = Date.now();
    const { expiresAt } = generateDownloadToken(JOB_ID, PROJECT_ID, ttlMs);
    const after = Date.now();

    // expiresAt should be within [before + ttlMs, after + ttlMs]
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + ttlMs);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(after + ttlMs + 100);
  });

  it('caps TTL to the minimum when a smaller value is supplied', () => {
    const { expiresAt } = generateDownloadToken(JOB_ID, PROJECT_ID, 1000); // 1 s
    // Should be capped to 5 min (300 000 ms)
    const diffMs = expiresAt.getTime() - Date.now();
    expect(diffMs).toBeGreaterThanOrEqual(4 * 60 * 1000);
  });

  it('caps TTL to the maximum when a larger value is supplied', () => {
    const { expiresAt } = generateDownloadToken(
      JOB_ID,
      PROJECT_ID,
      100 * 60 * 60 * 1000, // 100 hours
    );
    // Should be capped to 24 h (86 400 000 ms)
    const diffMs = expiresAt.getTime() - Date.now();
    expect(diffMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 500);
  });

  it('rejects a tampered payload', () => {
    const { token } = generateDownloadToken(JOB_ID, PROJECT_ID);
    const [, sig] = token.split('.');
    const fakePaylod = Buffer.from(
      JSON.stringify({ jobId: 'evil', projectId: PROJECT_ID, expiresAt: new Date(Date.now() + 3600_000).toISOString() }),
    ).toString('base64url');
    const tamperedToken = `${fakePaylod}.${sig}`;

    expect(() => verifyDownloadToken(tamperedToken)).toThrow(
      BadRequestException,
    );
  });

  it('rejects an expired token', () => {
    // Build a token whose expiresAt is in the past
    const past = new Date(Date.now() - 1000).toISOString();
    const payloadB64 = Buffer.from(
      JSON.stringify({ jobId: JOB_ID, projectId: PROJECT_ID, expiresAt: past }),
    ).toString('base64url');

    // Sign it properly so signature is valid, expiry is the issue
    const crypto = require('crypto');
    const secret = process.env.EXPORT_SIGNING_SECRET;
    const sig = crypto
      .createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64url');
    const expiredToken = `${payloadB64}.${sig}`;

    expect(() => verifyDownloadToken(expiredToken)).toThrow(BadRequestException);
    expect(() => verifyDownloadToken(expiredToken)).toThrow('expired');
  });

  it('rejects a token with wrong number of segments', () => {
    expect(() => verifyDownloadToken('no-dot-token')).toThrow(BadRequestException);
    expect(() => verifyDownloadToken('a.b.c')).toThrow(BadRequestException);
  });

  it('rejects a token with a non-JSON payload', () => {
    const crypto = require('crypto');
    const secret = process.env.EXPORT_SIGNING_SECRET;
    const badPayload = Buffer.from('not-json').toString('base64url');
    const sig = crypto
      .createHmac('sha256', secret)
      .update(badPayload)
      .digest('base64url');

    expect(() => verifyDownloadToken(`${badPayload}.${sig}`)).toThrow(BadRequestException);
  });
});

// ── TransactionExportService integration ─────────────────────────────────────

const CSV_DATA = 'id,amount\ntx-1,10.5';
const DATA_URI = `data:text/csv;base64,${Buffer.from(CSV_DATA).toString('base64')}`;

const completedJob = {
  id: 'job-1',
  projectId: 'proj-1',
  requestedBy: null,
  format: 'CSV',
  filters: null,
  status: 'COMPLETED',
  rowCount: 1,
  downloadUrl: DATA_URI,
  expiresAt: new Date(Date.now() + 3600_000),
  errorMessage: null,
  startedAt: new Date('2026-07-30T00:00:00.000Z'),
  completedAt: new Date('2026-07-30T00:00:01.000Z'),
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  updatedAt: new Date('2026-07-30T00:00:01.000Z'),
};

const pendingJob = { ...completedJob, status: 'PENDING', downloadUrl: null };

describe('TransactionExportService – download links (#552)', () => {
  let service: TransactionExportService;
  let mockPrisma: any;

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
        findMany: jest.fn().mockResolvedValue([]),
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

  describe('issueDownloadLink', () => {
    it('returns a token and downloadUrl for a completed job', async () => {
      mockPrisma.transactionExportJob.findFirst.mockResolvedValue(completedJob);

      const result = await service.issueDownloadLink('job-1', 'proj-1');

      expect(result.token).toBeTruthy();
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.downloadUrl).toContain('job-1');
      expect(result.downloadUrl).toContain('token=');
    });

    it('throws BadRequestException for a non-COMPLETED job', async () => {
      mockPrisma.transactionExportJob.findFirst.mockResolvedValue(pendingJob);

      await expect(
        service.issueDownloadLink('job-1', 'proj-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when the job does not exist', async () => {
      mockPrisma.transactionExportJob.findFirst.mockResolvedValue(null);

      await expect(
        service.issueDownloadLink('nonexistent', 'proj-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('issued token is verifiable and carries correct job/project IDs', async () => {
      mockPrisma.transactionExportJob.findFirst.mockResolvedValue(completedJob);

      const { token } = await service.issueDownloadLink('job-1', 'proj-1');
      const payload = verifyDownloadToken(token);

      expect(payload.jobId).toBe('job-1');
      expect(payload.projectId).toBe('proj-1');
    });
  });

  describe('resolveDownload', () => {
    it('returns the CSV content for a valid token', async () => {
      const { token } = generateDownloadToken('job-1', 'proj-1');
      mockPrisma.transactionExportJob.findFirst.mockResolvedValue(completedJob);

      const result = await service.resolveDownload('job-1', token);

      expect(result.mimeType).toBe('text/csv');
      expect(result.filename).toMatch(/export-job-1\.csv/);
      expect(result.content.toString('utf8')).toBe(CSV_DATA);
    });

    it('throws BadRequestException when token jobId does not match route param', async () => {
      const { token } = generateDownloadToken('job-1', 'proj-1');

      await expect(
        service.resolveDownload('different-job-id', token),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when job does not exist for the project in token', async () => {
      const { token } = generateDownloadToken('job-1', 'proj-1');
      mockPrisma.transactionExportJob.findFirst.mockResolvedValue(null);

      await expect(service.resolveDownload('job-1', token)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException for a tampered token', async () => {
      const { token } = generateDownloadToken('job-1', 'proj-1');
      const tampered = token.slice(0, -5) + 'XXXXX';

      await expect(service.resolveDownload('job-1', tampered)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('correctly resolves a JSON format export', async () => {
      const jsonData = JSON.stringify([{ id: 'tx-1' }], null, 2);
      const jsonUri = `data:application/json;base64,${Buffer.from(jsonData).toString('base64')}`;
      const jsonJob = { ...completedJob, format: 'JSON', downloadUrl: jsonUri };

      const { token } = generateDownloadToken('job-1', 'proj-1');
      mockPrisma.transactionExportJob.findFirst.mockResolvedValue(jsonJob);

      const result = await service.resolveDownload('job-1', token);

      expect(result.mimeType).toBe('application/json');
      expect(result.filename).toMatch(/\.json$/);
      expect(result.content.toString('utf8')).toBe(jsonData);
    });
  });
});
