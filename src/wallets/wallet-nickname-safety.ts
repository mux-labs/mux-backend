/**
 * Stable, typed error codes for the wallet nickname store.
 *
 * Clients branch on these codes, not on message text. Add new codes; never
 * repurpose an existing one.
 */
export const WalletNicknameErrorCode = {
  /** Input is not a usable nickname (wrong type, or over the length cap). */
  INVALID_INPUT: 'WALLET_NICKNAME_INVALID_INPUT',
  /** The sanitized value is empty but the caller did not ask to clear. */
  REJECTED_AFTER_SANITIZE: 'WALLET_NICKNAME_REJECTED_AFTER_SANITIZE',
  /** Another non-archived wallet of the same owner already uses this label. */
  DUPLICATE: 'WALLET_NICKNAME_DUPLICATE',
  /** The nickname store is unreachable; no write was applied. */
  DEPENDENCY_UNAVAILABLE: 'WALLET_NICKNAME_DEPENDENCY_UNAVAILABLE',
} as const;

export type WalletNicknameErrorCode =
  (typeof WalletNicknameErrorCode)[keyof typeof WalletNicknameErrorCode];

/**
 * Longest nickname the store will persist, in Unicode code points.
 *
 * Enforced here as well as on the DTO, because the DTO only guards the HTTP
 * boundary: `updateNickname` is a public service method that any other caller
 * (a script, a future internal endpoint, a test) can reach directly.
 */
export const WALLET_NICKNAME_MAX_LENGTH = 100;

/**
 * Hard cap on the *raw* input, checked before any sanitization work.
 *
 * Sanitization is a chain of regex replaces over the whole string, so an
 * unbounded input is unbounded CPU. Rejecting early means a caller cannot use
 * this endpoint to burn a request thread with a multi-megabyte "nickname".
 */
export const WALLET_NICKNAME_MAX_INPUT_LENGTH = 2_000;

/**
 * Defense-in-depth sanitization for a user-supplied wallet nickname.
 *
 * Strips tag-like sequences, drops `javascript:` URL schemes, removes inline
 * `on*` event-handler attributes, and discards control characters, so a stored
 * label is plain text that is safe to render in a dashboard even if a consumer
 * forgets to escape it.
 *
 * The result is NFC-normalized so two visually identical labels ("café" typed
 * with a combining accent vs. a precomposed one) collapse to the same string and
 * therefore collide in the uniqueness check instead of coexisting as duplicates
 * a user cannot tell apart.
 *
 * @param value Raw caller input. `null`/`undefined` pass through unchanged so
 *   the "clear the nickname" path still works.
 * @returns The sanitized label, or the original non-string input unchanged so
 *   the caller can reject it with a typed error.
 */
export function sanitizeWalletNickname(
  value: unknown,
): string | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'string') {
    return value as unknown as string;
  }

  return (
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/javascript\s*:/gi, '')
      .replace(/\s+on\w*\s*=/gi, ' ')
      // Stripping control characters is the point of this line: they are
      // exactly what makes a stored label unsafe to render or log.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      // Stripping a tag leaves the spaces that surrounded it, so collapse
      // internal runs. Otherwise "My<b> </b>Wallet" would store a label with a
      // double space that no user typed and that reads as a different label.
      .replace(/\s+/g, ' ')
      .normalize('NFC')
      .trim()
  );
}

/**
 * Resolves caller input to the value that should be stored, or a typed failure.
 *
 * ## Invariants
 *
 * 1. **Bounded work before bounded result.** The raw input length is checked
 *    first, so a huge string is rejected without running the sanitizer over it.
 * 2. **The length cap is on code points, not UTF-16 units.** A label of 100
 *    emoji is 200 UTF-16 units; measuring with `.length` would reject a label
 *    that is well within the documented 100-character limit.
 * 3. **Truncation never happens silently.** A label that sanitizes to
 *    something longer than the cap is rejected, not cut — a silently truncated
 *    nickname can collide with another wallet's label and produce a duplicate
 *    the uniqueness check cannot explain.
 * 4. **Non-string input is rejected, not coerced.** `123` or an object must not
 *    become the string "123" or "[object Object]".
 *
 * @returns `{ ok: true, value }` where `value` is `null` for a clear, or
 *   `{ ok: false, code, message }` for a typed rejection.
 */
export function resolveNicknameToStore(
  raw: unknown,
):
  | { ok: true; value: string | null }
  | { ok: false; code: WalletNicknameErrorCode; message: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, value: null };
  }

  if (typeof raw !== 'string') {
    return {
      ok: false,
      code: WalletNicknameErrorCode.INVALID_INPUT,
      message: 'nickname must be a string or null',
    };
  }

  // Invariant 1: bound the work before doing any of it.
  if (raw.length > WALLET_NICKNAME_MAX_INPUT_LENGTH) {
    return {
      ok: false,
      code: WalletNicknameErrorCode.INVALID_INPUT,
      message: `nickname must be at most ${WALLET_NICKNAME_MAX_INPUT_LENGTH} characters before sanitization`,
    };
  }

  const sanitized = sanitizeWalletNickname(raw);

  if (typeof sanitized !== 'string') {
    return {
      ok: false,
      code: WalletNicknameErrorCode.INVALID_INPUT,
      message: 'nickname must be a string or null',
    };
  }

  // An empty result is a legitimate clear: a whitespace-only or fully-stripped
  // label leaves the wallet unlabelled rather than storing an empty string.
  if (sanitized.length === 0) {
    return { ok: true, value: null };
  }

  // Invariant 2: count code points, not UTF-16 units.
  const codePoints = [...sanitized].length;
  if (codePoints > WALLET_NICKNAME_MAX_LENGTH) {
    // Invariant 3: reject rather than truncate.
    return {
      ok: false,
      code: WalletNicknameErrorCode.INVALID_INPUT,
      message: `nickname must be at most ${WALLET_NICKNAME_MAX_LENGTH} characters`,
    };
  }

  return { ok: true, value: sanitized };
}

/** Builds an Error carrying a stable, machine-readable `code`. */
export function nicknameError(
  code: WalletNicknameErrorCode,
  message: string,
): Error {
  const err = new Error(message) as Error & { code: WalletNicknameErrorCode };
  err.code = code;
  return err;
}
