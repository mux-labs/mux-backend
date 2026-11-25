import { Test } from '@nestjs/testing';
import { IdempotencyRecordStore, IdempotencyService } from './idempotency.service';

describe('IdempotencyService', () => {
  describe('IdempotencyRecordStore DI token', () => {
    it('is a distinct explicit token (not a string or class reference)', () => {
      expect(typeof IdempotencyRecordStore).toBe('symbol');
      expect(IdempotencyRecordStore.toString()).toBe('Symbol(IdempotencyRecordStore)');
    });

    it('binds the token to a structurally-compatible store provider', async () => {
      const store = {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      };

      const moduleRef = await Test.createTestingModule({
        providers: [
          IdempotencyService,
          { provide: IdempotencyRecordStore, useValue: store },
        ],
      }).compile();

      expect(moduleRef.get(IdempotencyRecordStore)).toBe(store);
    });

    it('fails to resolve when the token is not provided', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [IdempotencyService],
      }).compile();

      expect(() => moduleRef.get(IdempotencyRecordStore)).toThrow();
    });
  });
});
