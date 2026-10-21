const STELLAR_DECIMALS = 7;
const STELLAR_SCALE = BigInt(10 ** STELLAR_DECIMALS);
const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d{0,7}))?$/;

/**
 * Converts a decimal string with at most 7 fractional digits into integer
 * minor units (stroops). Throws on malformed or over-precise input rather than
 * silently rounding, so a balance check can never be decided on a truncated value.
 */
function toMinorUnits(value: string): bigint {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`Invalid decimal amount: ${value}`);
  }
  const [, sign, whole, fraction = ''] = match;
  const units = BigInt(whole) * STELLAR_SCALE + BigInt(fraction.padEnd(STELLAR_DECIMALS, '0'));
  return sign === '-' ? -units : units;
}

/**
 * Exact comparison of two decimal amount strings (up to 7 fractional digits).
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  const left = toMinorUnits(a);
  const right = toMinorUnits(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
