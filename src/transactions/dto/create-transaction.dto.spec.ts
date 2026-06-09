import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateTransactionDto } from './create-transaction.dto';
import { AssetType } from '../../balance-indexer/domain/balance.model';

const VALID_PUBLIC_KEY =
  'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

function build(overrides: Record<string, any> = {}): CreateTransactionDto {
  return plainToInstance(CreateTransactionDto, {
    amount: '10.5',
    asset: { type: AssetType.NATIVE },
    senderWalletId: VALID_UUID,
    ...overrides,
  });
}

async function errors(dto: CreateTransactionDto) {
  return validate(dto);
}

describe('CreateTransactionDto', () => {
  it('passes for a valid native XLM transaction', async () => {
    expect(await errors(build())).toHaveLength(0);
  });

  it('passes for a valid credit asset transaction', async () => {
    const dto = build({
      asset: {
        type: AssetType.CREDIT_ALPHANUM4,
        code: 'USDC',
        issuer: VALID_ISSUER,
      },
      receiverWalletId: VALID_UUID,
    });
    expect(await errors(dto)).toHaveLength(0);
  });

  // amount
  it('fails for a negative amount', async () => {
    expect(await errors(build({ amount: '-1' }))).not.toHaveLength(0);
  });

  it('fails for zero amount', async () => {
    expect(await errors(build({ amount: '0' }))).not.toHaveLength(0);
  });

  it('fails for amount with more than 7 decimal places', async () => {
    expect(await errors(build({ amount: '1.00000001' }))).not.toHaveLength(0);
  });

  it('passes for amount with exactly 7 decimal places', async () => {
    expect(await errors(build({ amount: '0.0000001' }))).toHaveLength(0);
  });

  it('fails for non-numeric amount', async () => {
    expect(await errors(build({ amount: 'abc' }))).not.toHaveLength(0);
  });

  // asset type
  it('fails for an unsupported asset type', async () => {
    const dto = build({ asset: { type: 'INVALID_TYPE' } });
    expect(await errors(dto)).not.toHaveLength(0);
  });

  // credit asset — code required
  it('fails when code is missing for a credit asset', async () => {
    const dto = build({
      asset: { type: AssetType.CREDIT_ALPHANUM4, issuer: VALID_ISSUER },
    });
    expect(await errors(dto)).not.toHaveLength(0);
  });

  it('fails when code exceeds 12 characters', async () => {
    const dto = build({
      asset: {
        type: AssetType.CREDIT_ALPHANUM12,
        code: 'TOOLONGASSETCODE',
        issuer: VALID_ISSUER,
      },
    });
    expect(await errors(dto)).not.toHaveLength(0);
  });

  // issuer
  it('fails when issuer is missing for a credit asset', async () => {
    const dto = build({
      asset: { type: AssetType.CREDIT_ALPHANUM4, code: 'USDC' },
    });
    expect(await errors(dto)).not.toHaveLength(0);
  });

  it('fails for an invalid Stellar public key as issuer', async () => {
    const dto = build({
      asset: {
        type: AssetType.CREDIT_ALPHANUM4,
        code: 'USDC',
        issuer: 'not-a-key',
      },
    });
    expect(await errors(dto)).not.toHaveLength(0);
  });

  // senderWalletId
  it('fails for a non-UUID senderWalletId', async () => {
    expect(
      await errors(build({ senderWalletId: 'not-a-uuid' })),
    ).not.toHaveLength(0);
  });

  // receiverWalletId
  it('fails for a non-UUID receiverWalletId', async () => {
    expect(
      await errors(build({ receiverWalletId: 'bad-id' })),
    ).not.toHaveLength(0);
  });

  // memo
  it('fails when memo exceeds 28 characters', async () => {
    expect(await errors(build({ memo: 'a'.repeat(29) }))).not.toHaveLength(0);
  });

  it('passes when memo is exactly 28 characters', async () => {
    expect(await errors(build({ memo: 'a'.repeat(28) }))).toHaveLength(0);
  });

  it('passes when memo is absent', async () => {
    expect(await errors(build())).toHaveLength(0);
  });
});
