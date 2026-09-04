import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { BalanceFilterDto } from './balance-filter.dto';
import { GetBalanceQueryDto } from './get-balance.query';
import { SyncBalancesDto } from './sync-balances.dto';
import { ReconcileBalanceDto } from './reconcile-balance.dto';
import { AssetType } from '../domain/balance.model';

describe('Balance Indexer DTOs - Validation', () => {
  // ─── PaginationDto ────────────────────────────────────────────────────────

  describe('PaginationDto', () => {
    it('accepts valid page and limit', async () => {
      const dto = plainToInstance(PaginationDto, { page: 1, limit: 20 });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('defaults to page=1 and limit=20', async () => {
      const dto = plainToInstance(PaginationDto, {});
      expect(dto.page).toBe(1);
      expect(dto.limit).toBe(20);
    });

    it('rejects page < 1', async () => {
      const dto = plainToInstance(PaginationDto, { page: 0, limit: 20 });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('min');
    });

    it('rejects non-integer page', async () => {
      const dto = plainToInstance(PaginationDto, { page: '1.5', limit: 20 });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects limit < 1', async () => {
      const dto = plainToInstance(PaginationDto, { page: 1, limit: 0 });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('min');
    });

    it('rejects limit > 100', async () => {
      const dto = plainToInstance(PaginationDto, { page: 1, limit: 101 });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('max');
    });

    it('coerces string numbers to integers', async () => {
      const dto = plainToInstance(PaginationDto, { page: '2', limit: '50' });
      expect(dto.page).toBe(2);
      expect(dto.limit).toBe(50);
    });
  });

  // ─── BalanceFilterDto ─────────────────────────────────────────────────────

  describe('BalanceFilterDto', () => {
    it('accepts valid assetType', async () => {
      const dto = plainToInstance(BalanceFilterDto, {
        assetType: AssetType.NATIVE,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts assetCode', async () => {
      const dto = plainToInstance(BalanceFilterDto, { assetCode: 'USD' });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts both assetType and assetCode', async () => {
      const dto = plainToInstance(BalanceFilterDto, {
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'EUR',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects invalid assetType', async () => {
      const dto = plainToInstance(BalanceFilterDto, { assetType: 'INVALID' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('rejects non-string assetCode', async () => {
      const dto = plainToInstance(BalanceFilterDto, { assetCode: 123 });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('isString');
    });

    it('allows empty object (all optional)', async () => {
      const dto = plainToInstance(BalanceFilterDto, {});
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  // ─── GetBalanceQueryDto ────────────────────────────────────────────────────

  describe('GetBalanceQueryDto', () => {
    it('accepts assetType only', async () => {
      const dto = plainToInstance(GetBalanceQueryDto, {
        assetType: AssetType.NATIVE,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts assetType with code and issuer', async () => {
      const dto = plainToInstance(GetBalanceQueryDto, {
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
        assetIssuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects invalid assetType', async () => {
      const dto = plainToInstance(GetBalanceQueryDto, {
        assetType: 'BADTYPE',
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('allows empty object', async () => {
      const dto = plainToInstance(GetBalanceQueryDto, {});
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects non-string assetCode', async () => {
      const dto = plainToInstance(GetBalanceQueryDto, { assetCode: 100 });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects non-string assetIssuer', async () => {
      const dto = plainToInstance(GetBalanceQueryDto, {
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
        assetIssuer: 123,
      });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // ─── SyncBalancesDto ───────────────────────────────────────────────────────

  describe('SyncBalancesDto', () => {
    it('accepts forceRefresh=true', async () => {
      const dto = plainToInstance(SyncBalancesDto, { forceRefresh: true });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts forceRefresh=false', async () => {
      const dto = plainToInstance(SyncBalancesDto, { forceRefresh: false });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('defaults to empty object', async () => {
      const dto = plainToInstance(SyncBalancesDto, {});
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects non-boolean forceRefresh', async () => {
      const dto = plainToInstance(SyncBalancesDto, { forceRefresh: 'yes' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('isBoolean');
    });

    it('coerces boolean strings (type coercion)', async () => {
      const dto = plainToInstance(SyncBalancesDto, { forceRefresh: 'true' });
      // Note: class-validator does NOT coerce strings to booleans without explicit transform
      // This tests that validation fails as expected
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // ─── ReconcileBalanceDto ──────────────────────────────────────────────────

  describe('ReconcileBalanceDto', () => {
    it('requires assetType', async () => {
      const dto = plainToInstance(ReconcileBalanceDto, {});
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('isNotEmpty');
    });

    it('accepts NATIVE asset', async () => {
      const dto = plainToInstance(ReconcileBalanceDto, {
        assetType: AssetType.NATIVE,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts CREDIT_ALPHANUM4 with code and issuer', async () => {
      const dto = plainToInstance(ReconcileBalanceDto, {
        assetType: AssetType.CREDIT_ALPHANUM4,
        assetCode: 'USD',
        assetIssuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts CREDIT_ALPHANUM12', async () => {
      const dto = plainToInstance(ReconcileBalanceDto, {
        assetType: AssetType.CREDIT_ALPHANUM12,
        assetCode: 'LONGCURRENCYNAME',
        assetIssuer: 'GBUQWP3BOUZX34ZONKXRBTLNNDOWR5HLCVPL2B4XNCLJTLMUMLTSOGBM',
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('accepts LIQUIDITY_POOL_SHARES', async () => {
      const dto = plainToInstance(ReconcileBalanceDto, {
        assetType: AssetType.LIQUIDITY_POOL_SHARES,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects invalid assetType', async () => {
      const dto = plainToInstance(ReconcileBalanceDto, { assetType: 'INVALID' });
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints).toHaveProperty('isEnum');
    });

    it('allows optional assetCode and assetIssuer', async () => {
      const dto = plainToInstance(ReconcileBalanceDto, {
        assetType: AssetType.NATIVE,
        assetCode: undefined,
        assetIssuer: undefined,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });
});
