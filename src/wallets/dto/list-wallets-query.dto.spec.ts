// class-validator decorators rely on Reflect.getMetadata.
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  DEFAULT_WALLET_LIST_LIMIT,
  ListWalletsQueryDto,
  MAX_WALLET_LIST_LIMIT,
} from './list-wallets-query.dto';
import {
  clampWalletListLimit,
  clampWalletListOffset,
} from '../wallets.service';

/**
 * Runs the DTO through the same transform + validate path as `main.ts`:
 * `whitelist: true, forbidNonWhitelisted: true`.
 */
function validate(query: Record<string, unknown>): string[] {
  const dto = plainToInstance(ListWalletsQueryDto, query, {
    enableImplicitConversion: false,
  });
  return validateSync(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);
}

describe('ListWalletsQueryDto (#936)', () => {
  describe('network filter', () => {
    it('accepts a valid network', () => {
      expect(validate({ network: 'TESTNET' })).toEqual([]);
      expect(validate({ network: 'MAINNET' })).toEqual([]);
    });

    it('rejects an unknown network instead of widening the result set', () => {
      // The whole point: a typo must fail loudly, not match both networks.
      expect(validate({ network: 'NOT_A_NETWORK' })).toContain('network');
    });

    it('rejects a lowercase network (the enum is closed and upper-case)', () => {
      expect(validate({ network: 'testnet' })).toContain('network');
    });

    it('allows network to be omitted', () => {
      expect(validate({})).toEqual([]);
    });
  });

  describe('status filter', () => {
    it('accepts a valid status', () => {
      expect(validate({ status: 'ACTIVE' })).toEqual([]);
    });

    it('rejects an unknown status', () => {
      expect(validate({ status: 'NOT_A_STATUS' })).toContain('status');
    });
  });

  describe('pagination bounds', () => {
    it('defaults limit and offset when omitted', () => {
      const dto = plainToInstance(ListWalletsQueryDto, {});

      expect(dto.limit).toBe(DEFAULT_WALLET_LIST_LIMIT);
      expect(dto.offset).toBe(0);
    });

    it('accepts the maximum documented limit', () => {
      expect(validate({ limit: MAX_WALLET_LIST_LIMIT })).toEqual([]);
    });

    it('rejects a limit above the maximum', () => {
      expect(validate({ limit: MAX_WALLET_LIST_LIMIT + 1 })).toContain('limit');
    });

    it('rejects a limit below 1', () => {
      expect(validate({ limit: 0 })).toContain('limit');
    });

    it('rejects a negative offset', () => {
      expect(validate({ offset: -1 })).toContain('offset');
    });

    it('rejects a non-numeric limit', () => {
      expect(validate({ limit: 'all' })).toContain('limit');
    });

    it('rejects a fractional limit', () => {
      expect(validate({ limit: 1.5 })).toContain('limit');
    });
  });

  describe('boolean flags are opt-in only', () => {
    it('enables includeArchived only on the literal "true"', () => {
      expect(
        plainToInstance(ListWalletsQueryDto, {
          includeArchived: 'true',
        }).includeArchived,
      ).toBe(true);

      // "1"/"yes" must not silently take a different code path than documented.
      expect(
        plainToInstance(ListWalletsQueryDto, {
          includeArchived: '1',
        }).includeArchived,
      ).toBe(false);
    });

    it('enables loadTestMode only on the literal "true"', () => {
      expect(
        plainToInstance(ListWalletsQueryDto, { loadTestMode: 'true' })
          .loadTestMode,
      ).toBe(true);
      expect(
        plainToInstance(ListWalletsQueryDto, { loadTestMode: 'yes' })
          .loadTestMode,
      ).toBe(false);
    });
  });

  describe('deny-by-default', () => {
    it('rejects an unknown query parameter', () => {
      expect(validate({ isAdmin: 'true' })).toContain('isAdmin');
    });
  });
});

describe('wallet list clamps (#936)', () => {
  describe('clampWalletListLimit', () => {
    it('falls back to the default when absent', () => {
      expect(clampWalletListLimit(undefined)).toBe(DEFAULT_WALLET_LIST_LIMIT);
    });

    it('falls back to the default for a non-finite value', () => {
      expect(clampWalletListLimit(Number.NaN)).toBe(DEFAULT_WALLET_LIST_LIMIT);
    });

    it('clamps above the maximum', () => {
      expect(clampWalletListLimit(10_000)).toBe(MAX_WALLET_LIST_LIMIT);
    });

    it('clamps below 1', () => {
      expect(clampWalletListLimit(0)).toBe(1);
      expect(clampWalletListLimit(-5)).toBe(1);
    });

    it('truncates a fractional value', () => {
      expect(clampWalletListLimit(10.9)).toBe(10);
    });

    it('passes a valid value through', () => {
      expect(clampWalletListLimit(50)).toBe(50);
    });
  });

  describe('clampWalletListOffset', () => {
    it('defaults to 0', () => {
      expect(clampWalletListOffset(undefined)).toBe(0);
    });

    it('floors a negative offset at 0', () => {
      expect(clampWalletListOffset(-5)).toBe(0);
    });

    it('truncates a fractional offset', () => {
      expect(clampWalletListOffset(3.9)).toBe(3);
    });

    it('passes a valid offset through', () => {
      expect(clampWalletListOffset(40)).toBe(40);
    });
  });
});
