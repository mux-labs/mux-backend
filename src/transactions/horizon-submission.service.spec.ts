import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { HorizonSubmissionService } from './horizon-submission.service';
import { TransactionsService } from './transactions.service';
import { TransactionStatus } from './domain/transaction.model';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock(
  '../generated/prisma/client',
  () => ({
    PrismaClient: jest.fn().mockImplementation(() => ({})),
  }),
  { virtual: true },
);

describe('HorizonSubmissionService', () => {
  let service: HorizonSubmissionService;
  let updateStatus: jest.Mock;

  const TX_ID = 'tx-uuid-123';
  const SIGNED_XDR = 'AAAA...signedXDR==';
  const STELLAR_HASH = 'abc123hash';

  beforeEach(async () => {
    updateStatus = jest.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HorizonSubmissionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockReturnValue('https://horizon-testnet.stellar.org'),
          },
        },
        {
          provide: TransactionsService,
          useValue: { updateStatus },
        },
      ],
    }).compile();

    service = module.get(HorizonSubmissionService);
  });

  afterEach(() => jest.clearAllMocks());

  it('returns SubmissionResult and persists CONFIRMED on success', async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        successful: true,
        hash: STELLAR_HASH,
        ledger: 42,
        fee_charged: '100',
      },
    });

    const result = await service.submitTransaction(TX_ID, SIGNED_XDR);

    expect(result).toEqual({
      transactionId: TX_ID,
      stellarHash: STELLAR_HASH,
      status: TransactionStatus.CONFIRMED,
    });
    expect(updateStatus).toHaveBeenCalledWith(TX_ID, {
      status: TransactionStatus.CONFIRMED,
      stellarHash: STELLAR_HASH,
      stellarLedger: 42,
      stellarFee: '100',
    });
  });

  it('throws ServiceUnavailableException on network error', async () => {
    const networkError: any = new Error('ECONNREFUSED');
    networkError.isAxiosError = true;
    networkError.response = undefined;
    mockedAxios.post.mockRejectedValue(networkError);

    await expect(service.submitTransaction(TX_ID, SIGNED_XDR)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('throws BadRequestException and persists FAILED on 400 rejection', async () => {
    const axiosError: any = new Error('Bad Request');
    axiosError.isAxiosError = true;
    axiosError.response = {
      status: 400,
      data: {
        extras: { result_codes: { transaction: 'tx_bad_seq' } },
      },
    };
    mockedAxios.post.mockRejectedValue(axiosError);

    await expect(service.submitTransaction(TX_ID, SIGNED_XDR)).rejects.toThrow(
      BadRequestException,
    );
    expect(updateStatus).toHaveBeenCalledWith(TX_ID, {
      status: TransactionStatus.FAILED,
      statusReason: 'tx_bad_seq',
    });
  });

  it('throws ServiceUnavailableException on 500 Horizon error', async () => {
    const axiosError: any = new Error('Internal Server Error');
    axiosError.isAxiosError = true;
    axiosError.response = { status: 500, data: {} };
    mockedAxios.post.mockRejectedValue(axiosError);

    await expect(service.submitTransaction(TX_ID, SIGNED_XDR)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
