import { applyDecorators } from '@nestjs/common';
import { IsString, Matches, MaxLength, ValidationOptions } from 'class-validator';

/**
 * Positive integer in the asset's smallest unit (stroops), with no sign,
 * decimal point, exponent, or leading zeros. Zero is rejected.
 */
export const STROOPS_AMOUNT_PATTERN = /^[1-9][0-9]*$/;

/**
 * Longest decimal string that fits in an i128 (the Soroban token amount type).
 */
export const STROOPS_AMOUNT_MAX_LENGTH = 39;

/**
 * Runtime check mirroring the decorator, for callers outside the DTO layer.
 */
export function isPositiveStroopsString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= STROOPS_AMOUNT_MAX_LENGTH &&
    STROOPS_AMOUNT_PATTERN.test(value)
  );
}

/**
 * `@IsPositive()` only applies to numbers, so it silently passes strings.
 * This decorator validates the string form directly.
 */
export function IsPositiveStroopsString(validationOptions?: ValidationOptions) {
  return applyDecorators(
    IsString(validationOptions),
    Matches(STROOPS_AMOUNT_PATTERN, validationOptions),
    MaxLength(STROOPS_AMOUNT_MAX_LENGTH, validationOptions),
  );
}
