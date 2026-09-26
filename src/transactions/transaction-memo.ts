/**
 * Transaction memo validation.
 *
 * A memo is client-supplied free text that is stored, indexed, and searchable
 * (`GET /transactions?memo=`), and it is also the value that ends up in a
 * Stellar `MemoText` on-chain. Stellar caps `MemoText` at 28 **bytes**, so a
 * memo that validates fine in JavaScript can still be un-submittable: "28
 * characters" of multi-byte UTF-8 is more than 28 bytes and the transaction
 * would fail only after it reached the network.
 *
 * This module is the single place that decides whether a memo is admissible, so
 * a create path, an import, and a replay of an older client cannot disagree.
 */

/**
 * Maximum memo length in bytes, matching Stellar's `MemoText` limit.
 *
 * Exceeding it means the transaction cannot be submitted, so the write is
 * refused at the API boundary rather than after a signature and a network
 * round trip.
 */
export const MAX_MEMO_BYTES = 28;

/**
 * Maximum memo length in JavaScript characters, as a coarse input bound.
 *
 * Every character is at least one byte, so this is a superset of the byte
 * limit. It exists only so an oversized body is rejected without first being
 * scanned byte-by-byte.
 */
export const MAX_MEMO_CHARS = MAX_MEMO_BYTES;

/**
 * Rejection codes for a memo. Stable: clients branch on the code, not the
 * message. Add new codes; never repurpose one.
 */
export const MemoErrorCode = {
  /** The memo is not a string, or is longer than {@link MAX_MEMO_CHARS}. */
  MEMO_TYPE_INVALID: 'MEMO_TYPE_INVALID',
  /** The memo exceeds {@link MAX_MEMO_BYTES} once encoded as UTF-8. */
  MEMO_TOO_LONG: 'MEMO_TOO_LONG',
  /** The memo contains a control character or an unpaired surrogate. */
  MEMO_CHARSET_INVALID: 'MEMO_CHARSET_INVALID',
  /** The memo is present but empty once trimmed; use `null` for "no memo". */
  MEMO_EMPTY: 'MEMO_EMPTY',
} as const;

export type MemoErrorCode = (typeof MemoErrorCode)[keyof typeof MemoErrorCode];

/**
 * A memo validation failure.
 *
 * `message` is client-safe and fixed per code: it never echoes the memo
 * itself, because a memo is user-supplied content that can contain anything.
 */
export class MemoValidationError extends Error {
  readonly code: MemoErrorCode;

  constructor(code: MemoErrorCode, message: string) {
    super(message);
    this.name = 'MemoValidationError';
    this.code = code;
  }
}

/**
 * Control characters (C0, DEL, and C1) are not representable in a Stellar text
 * memo and make a stored memo unsafe to echo into logs, CSV exports, and
 * terminals. Rejecting them at write time is cheaper than sanitising later.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;

/**
 * Detects an unpaired surrogate code unit.
 *
 * `Buffer.byteLength` and `TextEncoder` both silently substitute U+FFFD for a
 * lone surrogate, so a memo containing one would be stored as a different
 * value than the client sent — and the substitution can change the byte count.
 * A well-formed pair (`\uD83D\uDE00`) is fine and is not matched here.
 */
function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      i += 1; // consume the well-formed low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // A low surrogate with no preceding high surrogate.
      return true;
    }
  }
  return false;
}

/**
 * Validates and normalises a client-supplied memo.
 *
 * Invariants:
 *
 * 1. **`undefined`/`null` mean "no memo".** They normalise to `null`; they are
 *    never an error, because the column is nullable and most transactions have
 *    no memo.
 * 2. **Length is measured in UTF-8 bytes, not characters.** A 14-character
 *    emoji memo is 28 bytes and is refused; a 28-character ASCII memo is
 *    accepted. Checking `.length` would let an un-submittable memo through.
 * 3. **Whitespace-only is empty.** A memo that normalises to nothing is an
 *    explicit `MEMO_EMPTY` rather than a silently stored blank, so a caller
 *    cannot believe a memo was recorded when it was not.
 * 4. **Control characters and unpaired surrogates are refused.** They cannot
 *    survive the XDR encoding and are a log-injection vector once stored.
 * 5. **The value is returned trimmed and unchanged otherwise.** No truncation
 *    ever happens: a memo that does not fit is an error, never a value the
 *    client did not ask for.
 *
 * @throws MemoValidationError with a stable code on every failure path.
 */
export function normalizeMemo(memo: unknown): string | null {
  if (memo === undefined || memo === null) {
    return null;
  }

  if (typeof memo !== 'string') {
    throw new MemoValidationError(
      MemoErrorCode.MEMO_TYPE_INVALID,
      'memo must be a string',
    );
  }

  // Coarse bound first: an oversized string is rejected without a full scan.
  if (memo.length > MAX_MEMO_CHARS) {
    throw new MemoValidationError(
      MemoErrorCode.MEMO_TOO_LONG,
      `memo must be at most ${MAX_MEMO_BYTES} bytes`,
    );
  }

  if (CONTROL_CHARS.test(memo) || hasLoneSurrogate(memo)) {
    throw new MemoValidationError(
      MemoErrorCode.MEMO_CHARSET_INVALID,
      'memo must not contain control characters or unpaired surrogates',
    );
  }

  const trimmed = memo.trim();
  if (trimmed.length === 0) {
    throw new MemoValidationError(
      MemoErrorCode.MEMO_EMPTY,
      'memo must not be empty; omit it instead',
    );
  }

  if (Buffer.byteLength(trimmed, 'utf8') > MAX_MEMO_BYTES) {
    throw new MemoValidationError(
      MemoErrorCode.MEMO_TOO_LONG,
      `memo must be at most ${MAX_MEMO_BYTES} bytes`,
    );
  }

  return trimmed;
}

/** True when `memo` is admissible, i.e. `normalizeMemo` would not throw. */
export function isValidMemo(memo: unknown): boolean {
  try {
    normalizeMemo(memo);
    return true;
  } catch {
    return false;
  }
}
