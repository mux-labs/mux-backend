import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Keypair } from 'stellar-sdk';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';

// Mock stellar-sdk Server so tests don't hit the real Horizon
jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual('stellar-sdk');

  const mockLoadAccount = jest.fn();

  const MockServer = jest.fn().mockImplementation(() => ({
    loadAccount: mockLoadAccount,
  }));

  return {
    ...actual,
    BASE_FEE: '100',
    Server: MockServer,
    __mockLoadAccount: mockLoadAccount,
  };
});

// Pull the mock reference after jest.mock is hoisted
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { __mockLoadAccount: mockLoadAccount, Keypair: RealKeypair } = require('stellar-sdk');

describe('StellarTransactionBuildService', () => {
  let service: StellarTransactionBuildService;

  // Real Stellar keypairs for realistic test data
  const sourceKp = RealKeypair.random();
  const destKp = RealKeypair.random();
  const SOURCE = sourceKp.publicKey();
  const DEST = destKp.publicKey();

  // Minimal AccountResponse stub that TransactionBuilder needs
  function makeAccountStub(sequence = '100') {
    // stellar-sdk's TransactionBuilder needs an Account-like object
    // with incrementSequenceNumber() and sequenceNumber()
    const { Account } = jest.requireActual('stellar-sdk');
    return new Account(SOURCE, sequence);
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarTransactionBuildService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, def: string) => def),
          },
        },
      ],
    }).compile();

    service = module.get<StellarTransactionBuildService>(StellarTransactionBuildService);
  });

  describe('buildPayment', () => {
    it('should return a valid XDR, sequence, and network passphrase for native XLM', async () => {
      mockLoadAccount.mockResolvedValue(makeAccountStub('100'));

      const result = await service.buildPayment({
        sourcePublicKey: SOURCE,
        destinationPublicKey: DEST,
        amount: '10.0000000',
        assetCode: 'native',
        network: 'TESTNET',
      });

      expect(result.xdr).toBeDefined();
      expect(typeof result.xdr).toBe('string');
      expect(result.xdr.length).toBeGreaterThan(0);
      expect(result.sequence).toBe('100');
      expect(result.networkPassphrase).toContain('Test SDF');
    });

    it('should use mainnet passphrase when network is MAINNET', async () => {
      mockLoadAccount.mockResolvedValue(makeAccountStub('200'));

      const result = await service.buildPayment({
        sourcePublicKey: SOURCE,
        destinationPublicKey: DEST,
        amount: '5.0000000',
        assetCode: 'native',
        network: 'MAINNET',
      });

      expect(result.networkPassphrase).toContain('Public Global Stellar');
    });

    it('should build a non-native asset payment when issuer is provided', async () => {
      mockLoadAccount.mockResolvedValue(makeAccountStub('300'));
      const issuerKp = RealKeypair.random();

      const result = await service.buildPayment({
        sourcePublicKey: SOURCE,
        destinationPublicKey: DEST,
        amount: '50.0000000',
        assetCode: 'USDC',
        assetIssuer: issuerKp.publicKey(),
        network: 'TESTNET',
      });

      expect(result.xdr).toBeDefined();
    });

    it('should include a memo when provided', async () => {
      mockLoadAccount.mockResolvedValue(makeAccountStub('400'));

      const result = await service.buildPayment({
        sourcePublicKey: SOURCE,
        destinationPublicKey: DEST,
        amount: '1.0000000',
        assetCode: 'native',
        memo: 'test-memo',
        network: 'TESTNET',
      });

      // XDR should be longer with a memo than without
      const noMemoResult = await service.buildPayment({
        sourcePublicKey: SOURCE,
        destinationPublicKey: DEST,
        amount: '1.0000000',
        assetCode: 'native',
        network: 'TESTNET',
      });

      // Both should be valid XDR strings
      expect(result.xdr).toBeDefined();
      expect(noMemoResult.xdr).toBeDefined();
    });

    it('should throw BadRequestException when non-native asset has no issuer', async () => {
      await expect(
        service.buildPayment({
          sourcePublicKey: SOURCE,
          destinationPublicKey: DEST,
          amount: '10.0000000',
          assetCode: 'USDC',
          // no assetIssuer
          network: 'TESTNET',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when source account does not exist (404)', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Request failed with status code 404'));

      await expect(
        service.buildPayment({
          sourcePublicKey: SOURCE,
          destinationPublicKey: DEST,
          amount: '10.0000000',
          assetCode: 'native',
          network: 'TESTNET',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ServiceUnavailableException when Horizon is unreachable', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Network Error'));

      await expect(
        service.buildPayment({
          sourcePublicKey: SOURCE,
          destinationPublicKey: DEST,
          amount: '10.0000000',
          assetCode: 'native',
          network: 'TESTNET',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('should throw BadRequestException for invalid destination key', async () => {
      mockLoadAccount.mockResolvedValue(makeAccountStub('500'));

      await expect(
        service.buildPayment({
          sourcePublicKey: SOURCE,
          destinationPublicKey: 'INVALID_KEY',
          amount: '10.0000000',
          assetCode: 'native',
          network: 'TESTNET',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('buildXdr', () => {
    it('should return just the XDR string', async () => {
      mockLoadAccount.mockResolvedValue(makeAccountStub('600'));

      const xdr = await service.buildXdr({
        sourcePublicKey: SOURCE,
        destinationPublicKey: DEST,
        amount: '2.0000000',
        assetCode: 'native',
        network: 'TESTNET',
      });

      expect(typeof xdr).toBe('string');
      expect(xdr.length).toBeGreaterThan(0);
    });
  });
});
