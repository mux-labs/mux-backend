import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BatchPaymentDto } from './batch-payment.dto';

describe('BatchPaymentDto', () => {
  it('should fail when payments array is empty', async () => {
    const dto = plainToInstance(BatchPaymentDto, { payments: [] });
    const errors = await validate(dto);
    const batchError = errors.find((e) => e.property === 'payments');
    expect(batchError).toBeDefined();
    const messages = Object.values(batchError!.constraints ?? {});
    expect(messages.some((m) => m.includes('must not be empty'))).toBe(true);
  });

  it('should fail when payments field is missing', async () => {
    const dto = plainToInstance(BatchPaymentDto, {});
    const errors = await validate(dto);
    expect(errors.find((e) => e.property === 'payments')).toBeDefined();
  });

  it('should fail when payments is not an array', async () => {
    const dto = plainToInstance(BatchPaymentDto, { payments: 'not-an-array' });
    const errors = await validate(dto);
    const batchError = errors.find((e) => e.property === 'payments');
    expect(batchError).toBeDefined();
  });
});
