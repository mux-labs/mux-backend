import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StellarSigningService } from './stellar-signing.service';
import {
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Asset,
  Operation,
  Account,
} from 'stellar-sdk';

const serverKeypair = Keypair.random();

function buildUnsignedXdr(): string {
  const sourceKeypair = Keypair.random();
  const account = new Account(sourceKeypair.publicKey(), '100');
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(30)
    .build();
  return tx.toEnvelope().toXDR('base64');
}

describe('StellarSigningService', () => {
  let service: StellarSigningService;
  let configGet: jest.Mock;

  beforeEach(async () => {
    configGet = jest.fn().mockImplementation((key: string) => {
      if (key === 'STELLAR_SERVER_SECRET_KEY') return serverKeypair.secret();
      if (key === 'STELLAR_NETWORK_PASSPHRASE') return Networks.TESTNET;
      return undefined;
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StellarSigningService,
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get(StellarSigningService);
  });

  it('signs a valid unsigned XDR and returns a signed XDR string', () => {
    const unsignedXdr = buildUnsignedXdr();
    const signedXdr = service.signTransaction(unsignedXdr);
    expect(typeof signedXdr).toBe('string');
    expect(signedXdr.length).toBeGreaterThan(0);
    expect(signedXdr).not.toBe(unsignedXdr);
  });

  it('throws InternalServerErrorException when STELLAR_SERVER_SECRET_KEY is not set', () => {
    configGet.mockImplementation((key: string) => {
      if (key === 'STELLAR_NETWORK_PASSPHRASE') return Networks.TESTNET;
      return undefined;
    });
    expect(() => service.signTransaction(buildUnsignedXdr())).toThrow(
      InternalServerErrorException,
    );
  });

  it('throws InternalServerErrorException when STELLAR_SERVER_SECRET_KEY is invalid', () => {
    configGet.mockImplementation((key: string) => {
      if (key === 'STELLAR_SERVER_SECRET_KEY') return 'NOT_A_VALID_SECRET';
      if (key === 'STELLAR_NETWORK_PASSPHRASE') return Networks.TESTNET;
      return undefined;
    });
    expect(() => service.signTransaction(buildUnsignedXdr())).toThrow(
      InternalServerErrorException,
    );
  });

  it('throws BadRequestException for invalid XDR input', () => {
    expect(() => service.signTransaction('not-valid-xdr')).toThrow(
      BadRequestException,
    );
  });
});
