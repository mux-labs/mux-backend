/**
 * Tests for:
 *   #498 – Map Horizon results to internal transaction status (SUBMITTED support)
 */
import {
  mapHorizonResultToStatus,
  HorizonTransactionResult,
} from './horizon-result.mapper';
import { TransactionStatus } from './domain/transaction.model';

describe('mapHorizonResultToStatus – #498 SUBMITTED / in-flight support', () => {
  // ── Existing CONFIRMED paths (regression) ─────────────────────────────────

  it('returns CONFIRMED when successful=true', () => {
    expect(mapHorizonResultToStatus({ successful: true })).toBe(
      TransactionStatus.CONFIRMED,
    );
  });

  it('returns CONFIRMED for result_code tx_success', () => {
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

  // ── #498: SUBMITTED (in-flight) paths ─────────────────────────────────────

  it('returns SUBMITTED when http_status is 202 (Horizon accepted, not yet in ledger)', () => {
    expect(mapHorizonResultToStatus({ http_status: 202 })).toBe(
      TransactionStatus.SUBMITTED,
    );
  });

  it('returns SUBMITTED for http_status 202 even when successful is absent', () => {
    const result: HorizonTransactionResult = {
      http_status: 202,
      hash: 'abc123',
    };
    expect(mapHorizonResultToStatus(result)).toBe(TransactionStatus.SUBMITTED);
  });

  it('returns SUBMITTED for result_code tx_queued', () => {
    expect(mapHorizonResultToStatus({ result_code: 'tx_queued' })).toBe(
      TransactionStatus.SUBMITTED,
    );
  });

  it('SUBMITTED takes precedence over successful=false when http_status=202', () => {
    const result: HorizonTransactionResult = {
      http_status: 202,
      successful: false,
    };
    expect(mapHorizonResultToStatus(result)).toBe(TransactionStatus.SUBMITTED);
  });

  // ── Existing FAILED paths (regression) ────────────────────────────────────

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

  it('returns FAILED when result is empty (no flags, no code)', () => {
    expect(mapHorizonResultToStatus({})).toBe(TransactionStatus.FAILED);
  });

  // ── Priority order ────────────────────────────────────────────────────────

  it('successful=true takes precedence over a failure result_code', () => {
    expect(
      mapHorizonResultToStatus({ successful: true, result_code: 'tx_failed' }),
    ).toBe(TransactionStatus.CONFIRMED);
  });

  it('http_status=202 takes precedence over a failure result_code', () => {
    // 202 means Horizon accepted it; result_code may not be set yet
    expect(
      mapHorizonResultToStatus({ http_status: 202, result_code: 'tx_failed' }),
    ).toBe(TransactionStatus.SUBMITTED);
  });

  it('http_status=200 does not trigger SUBMITTED (only 202 does)', () => {
    // 200 with no other signal should fall through to the default FAILED path
    expect(mapHorizonResultToStatus({ http_status: 200 })).toBe(
      TransactionStatus.FAILED,
    );
  });
});
