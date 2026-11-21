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
    it('rejects a zero amount', () => {
      expect(() => service.assertValidAmount(0)).toThrow();
    });

    it('rejects 0.0000000', () => {
      expect(() => service.assertValidAmount(0.0000000)).toThrow();
    });

    it('accepts the smallest 7-decimal amount 0.0000001', () => {
      expect(() => service.assertValidAmount(0.0000001)).not.toThrow();
    });
  });
});
