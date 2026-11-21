import { Test, TestingModule } from '@nestjs/testing';
import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
  let service: TransactionsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TransactionsService],
    }).compile();

    service = module.get<TransactionsService>(TransactionsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('assertValidAmount', () => {
    const assertValidAmount = (amount: string) =>
      (service as unknown as { assertValidAmount: (a: string) => void }).assertValidAmount(
        amount,
      );

    it.each(['1e7', '1.', ''])('rejects invalid amount %p', (amount) => {
      expect(() => assertValidAmount(amount)).toThrow(
        expect.objectContaining({ code: 'TRANSACTION_AMOUNT_INVALID' }),
      );
    });

    it('accepts a valid decimal amount', () => {
      expect(() => assertValidAmount('1.0000001')).not.toThrow();
    });
  });
});
