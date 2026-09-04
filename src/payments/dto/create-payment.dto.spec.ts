import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePaymentDto } from './create-payment.dto';

describe('CreatePaymentDto - Asset Code Validation', () => {
  describe('assetCode field', () => {
    it('should accept valid assetCode', async () => {
      const dto = plainToInstance(CreatePaymentDto, {
        walletId: '123e4567-e89b-12d3-a456-426614174000',
        receiverWalletId: '123e4567-e89b-12d3-a456-426614174001',
        amount: 100.5,
        currency: 'USD',
        assetCode: 'USD',
        fromId: 1,
        toId: 2,
      });

      const errors = await validate(dto);
      expect(errors).toEqual([]);
    });

    it('should accept optional assetCode', async () => {
      const dto = plainToInstance(CreatePaymentDto, {
        walletId: '123e4567-e89b-12d3-a456-426614174000',
        receiverWalletId: '123e4567-e89b-12d3-a456-426614174001',
        amount: 100.5,
        currency: 'USD',
        fromId: 1,
        toId: 2,
      });

      const errors = await validate(dto);
      expect(errors).toEqual([]);
    });

    it('should reject non-string assetCode', async () => {
      const dto = plainToInstance(CreatePaymentDto, {
        walletId: '123e4567-e89b-12d3-a456-426614174000',
        receiverWalletId: '123e4567-e89b-12d3-a456-426614174001',
        amount: 100.5,
        currency: 'USD',
        assetCode: 123,
        fromId: 1,
        toId: 2,
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('should accept custom asset codes', async () => {
      const dto = plainToInstance(CreatePaymentDto, {
        walletId: '123e4567-e89b-12d3-a456-426614174000',
        receiverWalletId: '123e4567-e89b-12d3-a456-426614174001',
        amount: 100.5,
        currency: 'USD',
        assetCode: 'CUSTOM_ASSET_001',
        fromId: 1,
        toId: 2,
      });

      const errors = await validate(dto);
      expect(errors).toEqual([]);
    });
  });

  describe('full payload validation', () => {
    it('should validate complete payment with assetCode', async () => {
      const dto = plainToInstance(CreatePaymentDto, {
        walletId: '123e4567-e89b-12d3-a456-426614174000',
        receiverWalletId: '123e4567-e89b-12d3-a456-426614174001',
        amount: 50.25,
        currency: 'EUR',
        assetCode: 'EUR',
        description: 'Invoice payment',
        fromId: 1,
        toId: 2,
      });

      const errors = await validate(dto);
      expect(errors).toEqual([]);
      expect(dto.assetCode).toBe('EUR');
    });
  });
});
