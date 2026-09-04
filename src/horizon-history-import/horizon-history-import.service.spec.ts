import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { HorizonHistoryImportService } from './horizon-history-import.service';
import { PrismaService } from '../prisma/prisma.service';
import { WalletNetwork } from '../wallets/domain/wallet.model';
import {
  HorizonHistoryResourceType,
  HorizonImportStatus,
} from './domain/horizon-import.model';

jest.mock('axios');

describe('HorizonHistoryImportService', () => {
  let service: HorizonHistoryImportService;
  let mockAxiosInstance: {
    get: jest.Mock;
    interceptors: { request: { use: jest.Mock } };
  };
  let horizonImportCursor: {
    upsert: jest.Mock;
    update: jest.Mock;
    findUnique: jest.Mock;
  };

  const ACCOUNT_ID = 'GABC123456789';
  const CURSOR_ID = 'cursor-uuid-1';

  function makeCursorRecord(overrides: Partial<any> = {}) {
    return {
      id: CURSOR_ID,
      accountId: ACCOUNT_ID,
      network: WalletNetwork.TESTNET,
      resourceType: HorizonHistoryResourceType.PAYMENTS,
      cursor: null,
      status: HorizonImportStatus.RUNNING,
      recordsImported: 0,
      lastError: null,
      lastAttemptAt: new Date(),
      lastSuccessAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    mockAxiosInstance = {
      get: jest.fn(),
      interceptors: { request: { use: jest.fn() } },
    };
    (axios.create as jest.Mock).mockReturnValue(mockAxiosInstance);

    horizonImportCursor = {
      upsert: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HorizonHistoryImportService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
          },
        },
        {
          provide: PrismaService,
          useValue: { horizonImportCursor },
        },
      ],
    }).compile();

    service = module.get(HorizonHistoryImportService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('resumeImport - success path', () => {
    it('starts from the beginning when no cursor is persisted yet', async () => {
      horizonImportCursor.upsert.mockResolvedValue(makeCursorRecord());
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          _embedded: {
            records: [
              { paging_token: '100', id: 'op-1' },
              { paging_token: '200', id: 'op-2' },
            ],
          },
        },
      });
      horizonImportCursor.update.mockResolvedValue(
        makeCursorRecord({
          cursor: '200',
          status: HorizonImportStatus.COMPLETED,
          recordsImported: 2,
        }),
      );

      const result = await service.resumeImport({ accountId: ACCOUNT_ID });

      // First page fetch must not send a `cursor` param when none is persisted
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        expect.stringContaining(`/accounts/${ACCOUNT_ID}/payments`),
        expect.objectContaining({
          params: expect.not.objectContaining({ cursor: expect.anything() }),
        }),
      );

      expect(result).toEqual({
        accountId: ACCOUNT_ID,
        network: WalletNetwork.TESTNET,
        resourceType: HorizonHistoryResourceType.PAYMENTS,
        cursor: '200',
        recordsImported: 2,
        recordsImportedThisRun: 2,
        status: HorizonImportStatus.COMPLETED,
      });

      expect(horizonImportCursor.update).toHaveBeenCalledWith({
        where: { id: CURSOR_ID },
        data: {
          cursor: '200',
          status: HorizonImportStatus.COMPLETED,
          recordsImported: { increment: 2 },
          lastSuccessAt: expect.any(Date),
          lastError: null,
        },
      });
    });

    it('resumes from the persisted cursor and advances it further', async () => {
      horizonImportCursor.upsert.mockResolvedValue(
        makeCursorRecord({ cursor: '200', recordsImported: 2 }),
      );
      mockAxiosInstance.get.mockResolvedValue({
        data: {
          _embedded: {
            records: [{ paging_token: '300', id: 'op-3' }],
          },
        },
      });
      horizonImportCursor.update.mockResolvedValue(
        makeCursorRecord({
          cursor: '300',
          status: HorizonImportStatus.COMPLETED,
          recordsImported: 3,
        }),
      );

      const result = await service.resumeImport({
        accountId: ACCOUNT_ID,
        resourceType: HorizonHistoryResourceType.PAYMENTS,
      });

      // Resume call must include the previously persisted cursor as a param
      expect(mockAxiosInstance.get).toHaveBeenCalledWith(
        expect.stringContaining(`/accounts/${ACCOUNT_ID}/payments`),
        expect.objectContaining({
          params: expect.objectContaining({ cursor: '200' }),
        }),
      );

      expect(result.cursor).toBe('300');
      expect(result.recordsImported).toBe(3);
      expect(result.recordsImportedThisRun).toBe(1);
    });

    it('keeps the existing cursor unchanged when Horizon returns an empty page', async () => {
      horizonImportCursor.upsert.mockResolvedValue(
        makeCursorRecord({ cursor: '200', recordsImported: 2 }),
      );
      mockAxiosInstance.get.mockResolvedValue({
        data: { _embedded: { records: [] } },
      });
      horizonImportCursor.update.mockResolvedValue(
        makeCursorRecord({
          cursor: '200',
          status: HorizonImportStatus.COMPLETED,
          recordsImported: 2,
        }),
      );

      const result = await service.resumeImport({ accountId: ACCOUNT_ID });

      expect(result.cursor).toBe('200');
      expect(result.recordsImportedThisRun).toBe(0);
      expect(horizonImportCursor.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cursor: '200' }),
        }),
      );
    });
  });

  describe('resumeImport - failure paths', () => {
    it('throws BadRequestException when accountId is missing', async () => {
      await expect(
        service.resumeImport({ accountId: '   ' }),
      ).rejects.toThrow(BadRequestException);
      expect(horizonImportCursor.upsert).not.toHaveBeenCalled();
    });

    it('records a FAILED attempt without advancing the cursor on a Horizon network error', async () => {
      horizonImportCursor.upsert.mockResolvedValue(
        makeCursorRecord({ cursor: '200', recordsImported: 2 }),
      );
      const networkError: any = new Error('ECONNREFUSED');
      networkError.isAxiosError = true;
      networkError.response = undefined;
      mockAxiosInstance.get.mockRejectedValue(networkError);
      horizonImportCursor.update.mockResolvedValue({});

      await expect(
        service.resumeImport({ accountId: ACCOUNT_ID }),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(horizonImportCursor.update).toHaveBeenCalledWith({
        where: { id: CURSOR_ID },
        data: {
          status: HorizonImportStatus.FAILED,
          lastError: expect.stringContaining('Horizon network error'),
          lastAttemptAt: expect.any(Date),
        },
      });
      // The failure update must never include a `cursor` key, i.e. the
      // persisted cursor is left exactly where it was.
      const failureUpdateArgs = horizonImportCursor.update.mock.calls[0][0];
      expect(failureUpdateArgs.data).not.toHaveProperty('cursor');
    });

    it('throws NotFoundException on a Horizon 404 (unknown account)', async () => {
      horizonImportCursor.upsert.mockResolvedValue(makeCursorRecord());
      const notFoundError: any = new Error('Not Found');
      notFoundError.isAxiosError = true;
      notFoundError.response = { status: 404, data: {} };
      mockAxiosInstance.get.mockRejectedValue(notFoundError);
      horizonImportCursor.update.mockResolvedValue({});

      await expect(
        service.resumeImport({ accountId: ACCOUNT_ID }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ServiceUnavailableException on a Horizon 5xx error', async () => {
      horizonImportCursor.upsert.mockResolvedValue(makeCursorRecord());
      const serverError: any = new Error('Internal Server Error');
      serverError.isAxiosError = true;
      serverError.response = { status: 503, data: {} };
      mockAxiosInstance.get.mockRejectedValue(serverError);
      horizonImportCursor.update.mockResolvedValue({});

      await expect(
        service.resumeImport({ accountId: ACCOUNT_ID }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('never leaks Horizon response bodies/headers into the persisted error message', async () => {
      horizonImportCursor.upsert.mockResolvedValue(makeCursorRecord());
      const rejectionError: any = new Error('Bad Request');
      rejectionError.isAxiosError = true;
      rejectionError.response = {
        status: 400,
        data: { secret_token: 'super-secret-value', detail: 'bad cursor' },
        headers: { authorization: 'Bearer secret-token' },
      };
      mockAxiosInstance.get.mockRejectedValue(rejectionError);
      horizonImportCursor.update.mockResolvedValue({});

      await expect(
        service.resumeImport({ accountId: ACCOUNT_ID }),
      ).rejects.toThrow(BadRequestException);

      const failureUpdateArgs = horizonImportCursor.update.mock.calls[0][0];
      expect(failureUpdateArgs.data.lastError).not.toContain('secret');
      expect(failureUpdateArgs.data.lastError).not.toContain('Bearer');
    });
  });
});
