import {
  TransactionStatus,
  createTransaction,
  canTransitionTransactionStatus,
  transitionTransactionStatus,
  Transaction,
} from './transaction.model';

describe('transaction.model', () => {
  describe('createTransaction', () => {
    it('creates a PENDING transaction with required fields', () => {
      const tx = createTransaction('50', { type: 'NATIVE' }, 'wallet-a');

      expect(tx.status).toBe(TransactionStatus.PENDING);
      expect(tx.amount).toBe('50');
      expect(tx.asset).toEqual({ type: 'NATIVE' });
      expect(tx.senderWalletId).toBe('wallet-a');
      expect(tx.receiverWalletId).toBeNull();
      expect(tx.stellarRefs).toEqual({});
      expect(tx.submittedAt).toBeNull();
      expect(tx.confirmedAt).toBeNull();
      expect(tx.failedAt).toBeNull();
      expect(tx.metadata).toBeNull();
      expect(tx.id).toBeDefined();
    });

    it('uses provided id and timestamp', () => {
      const at = new Date('2024-01-01');
      const tx = createTransaction(
        '10',
        { type: 'NATIVE' },
        'wallet-a',
        null,
        null,
        'fixed-id',
        at,
      );

      expect(tx.id).toBe('fixed-id');
      expect(tx.createdAt).toBe(at);
      expect(tx.updatedAt).toBe(at);
      expect(tx.statusChangedAt).toBe(at);
    });

    it('sets receiverWalletId and metadata when provided', () => {
      const tx = createTransaction(
        '10',
        { type: 'NATIVE' },
        'wallet-a',
        'wallet-b',
        { ref: '123' },
      );

      expect(tx.receiverWalletId).toBe('wallet-b');
      expect(tx.metadata).toEqual({ ref: '123' });
    });
  });

  describe('canTransitionTransactionStatus', () => {
    it.each([
      [TransactionStatus.PENDING, TransactionStatus.SUBMITTED, true],
      [TransactionStatus.PENDING, TransactionStatus.FAILED, true],
      [TransactionStatus.SUBMITTED, TransactionStatus.CONFIRMED, true],
      [TransactionStatus.SUBMITTED, TransactionStatus.FAILED, true],
      [TransactionStatus.CONFIRMED, TransactionStatus.FAILED, false],
      [TransactionStatus.FAILED, TransactionStatus.PENDING, false],
      [TransactionStatus.CONFIRMED, TransactionStatus.PENDING, false],
      [TransactionStatus.PENDING, TransactionStatus.CONFIRMED, false],
    ])('%s -> %s is %s', (from, to, expected) => {
      expect(canTransitionTransactionStatus(from, to)).toBe(expected);
    });
  });

  describe('transitionTransactionStatus', () => {
    let pending: Transaction;

    beforeEach(() => {
      pending = createTransaction(
        '100',
        { type: 'NATIVE' },
        'wallet-a',
        'wallet-b',
      );
    });

    it('transitions PENDING -> SUBMITTED and sets submittedAt', () => {
      const at = new Date('2024-06-01');
      const result = transitionTransactionStatus(
        pending,
        TransactionStatus.SUBMITTED,
        undefined,
        undefined,
        at,
      );

      expect(result.status).toBe(TransactionStatus.SUBMITTED);
      expect(result.submittedAt).toBe(at);
      expect(result.statusChangedAt).toBe(at);
      expect(result.updatedAt).toBe(at);
    });

    it('transitions SUBMITTED -> CONFIRMED and sets confirmedAt', () => {
      const submitted = transitionTransactionStatus(
        pending,
        TransactionStatus.SUBMITTED,
      );
      const at = new Date('2024-06-02');
      const result = transitionTransactionStatus(
        submitted,
        TransactionStatus.CONFIRMED,
        undefined,
        undefined,
        at,
      );

      expect(result.status).toBe(TransactionStatus.CONFIRMED);
      expect(result.confirmedAt).toBe(at);
    });

    it('transitions PENDING -> FAILED and sets failedAt', () => {
      const at = new Date('2024-06-01');
      const result = transitionTransactionStatus(
        pending,
        TransactionStatus.FAILED,
        'timeout',
        undefined,
        at,
      );

      expect(result.status).toBe(TransactionStatus.FAILED);
      expect(result.failedAt).toBe(at);
      expect(result.statusReason).toBe('timeout');
    });

    it('merges stellarRefs when provided', () => {
      const result = transitionTransactionStatus(
        pending,
        TransactionStatus.SUBMITTED,
        undefined,
        { hash: 'abc123', ledger: 42 },
      );

      expect(result.stellarRefs.hash).toBe('abc123');
      expect(result.stellarRefs.ledger).toBe(42);
    });

    it('throws on invalid transition', () => {
      const confirmed = transitionTransactionStatus(
        transitionTransactionStatus(pending, TransactionStatus.SUBMITTED),
        TransactionStatus.CONFIRMED,
      );

      expect(() =>
        transitionTransactionStatus(confirmed, TransactionStatus.PENDING),
      ).toThrow('Invalid transaction status transition');
    });

    it('returns same object when transitioning to same status', () => {
      const result = transitionTransactionStatus(
        pending,
        TransactionStatus.PENDING,
      );

      expect(result).toBe(pending);
    });

    it('does not mutate the original transaction', () => {
      const originalStatus = pending.status;
      transitionTransactionStatus(pending, TransactionStatus.SUBMITTED);

      expect(pending.status).toBe(originalStatus);
    });
  });
});
