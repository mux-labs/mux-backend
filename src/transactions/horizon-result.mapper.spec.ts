import {
  mapHorizonResultToStatus,
  HorizonTransactionResult,
} from './horizon-result.mapper';
import { TransactionStatus } from './domain/transaction.model';

describe('mapHorizonResultToStatus', () => {
  it('returns CONFIRMED when successful=true', () => {
    expect(mapHorizonResultToStatus({ successful: true })).toBe(
      TransactionStatus.CONFIRMED,
    );
  });

  it('returns CONFIRMED for tx_success result_code', () => {
    expect(mapHorizonResultToStatus({ result_code: 'tx_success' })).toBe(
      TransactionStatus.CONFIRMED,
    );
  });

  it('returns CONFIRMED for tx_fee_bump_inner_success', () => {
    expect(
      mapHorizonResultToStatus({ result_code: 'tx_fee_bump_inner_success' }),
    ).toBe(TransactionStatus.CONFIRMED);
  });

  it('returns CONFIRMED when result_code is in extras.result_codes.transaction', () => {
    const result: HorizonTransactionResult = {
      extras: { result_codes: { transaction: 'tx_success' } },
    };
    expect(mapHorizonResultToStatus(result)).toBe(TransactionStatus.CONFIRMED);
  });

  const failureCodes = [
    'tx_failed',
    'tx_too_early',
    'tx_too_late',
    'tx_missing_operation',
    'tx_bad_seq',
    'tx_bad_auth',
    'tx_insufficient_balance',
    'tx_no_source_account',
    'tx_insufficient_fee',
    'tx_bad_auth_extra',
    'tx_internal_error',
    'tx_not_supported',
    'tx_fee_bump_inner_failed',
    'tx_bad_sponsorship',
    'tx_bad_min_seq_age_or_gap',
    'tx_malformed',
  ];

  it.each(failureCodes)('returns FAILED for result_code "%s"', (code) => {
    expect(mapHorizonResultToStatus({ result_code: code })).toBe(
      TransactionStatus.FAILED,
    );
  });

  it('returns FAILED for an unknown result code', () => {
    expect(
      mapHorizonResultToStatus({ result_code: 'tx_some_future_code' }),
    ).toBe(TransactionStatus.FAILED);
  });

  it('returns FAILED when result is empty (no successful flag, no code)', () => {
    expect(mapHorizonResultToStatus({})).toBe(TransactionStatus.FAILED);
  });

  it('successful=true takes precedence over a failure result_code', () => {
    expect(
      mapHorizonResultToStatus({ successful: true, result_code: 'tx_failed' }),
    ).toBe(TransactionStatus.CONFIRMED);
  });
});
